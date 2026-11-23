import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type Role,
} from "@project/shared";
import { DurableObject } from "cloudflare:workers";
import { readRoomConfig, type RoomConfig } from "../../config";
import { errorBody, type Result } from "../../errors";
import type { RelayResource } from "../../relay";
import { createRealtime } from "../../relay/realtime";
import { generateId, generateToken, hashToken } from "../../room/crypto";
import {
  addMember,
  closeAt,
  createRoomState,
  findMember,
  findMemberByTokenHash,
  toRoomInfo,
  type RoomState,
} from "../../room/room";
import {
  CLOSE,
  closeRoomEffects,
  onAuth,
  onDisconnect,
  onMessage,
  type Effect,
} from "../../signaling/process";
import { INVITE_DIRECTORY_NAME, type Env } from "./env";

type Attachment = { memberId: string | null; authDeadline: number };

const STATE_KEY = "state";
const RELAY_KEY = "relay";
/** 關房後尚未清理完的外部資源（邀請碼對照、轉發 tracks）。存在時房間已不可用。 */
const CLOSING_KEY = "closing";
type Closing = {
  roomId: string;
  inviteCode: string;
  reason: CloseReason;
  attempts: number;
};
type CloseReason = "expired" | "host_closed";
/** 清理失敗的重試間隔：30 秒起跳、每次加倍、最多 1 小時；超過次數就放棄並記錄。 */
const CLEANUP_RETRY_BASE_MS = 30_000;
const CLEANUP_RETRY_MAX_MS = 60 * 60_000;
const CLEANUP_MAX_ATTEMPTS = 12;
type RelayState = {
  publicationId: string | null;
  resources: Record<string, RelayResource>;
};

/**
 * 每個房間一個實例。使用 WebSocket Hibernation API：
 * DO 可能隨時休眠，記憶體會清空，所以狀態一律寫進 storage，計時一律用 alarm。
 */
export class RoomDO extends DurableObject<Env> {
  private room: RoomState | null = null;
  private closing: Closing | null = null;
  /** 會呼叫其他 DO 的操作（重產邀請碼、關房）依序執行，見 exclusive()。 */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: RoomConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readRoomConfig(env as unknown as Record<string, unknown>);
    void ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
      this.closing = (await ctx.storage.get<Closing>(CLOSING_KEY)) ?? null;
    });
  }

  // ── RPC（由 Worker 呼叫）──────────────────────────────────

  async getRelayPublication(): Promise<RelayResource | null> {
    const relay = await this.ctx.storage.get<RelayState>(RELAY_KEY);
    if (!this.room?.stream.live || !relay?.publicationId) return null;
    return relay.resources[relay.publicationId] ?? null;
  }

  async registerRelayResource(resource: RelayResource): Promise<Result<null>> {
    return this.ctx.storage.transaction(async (txn) => {
      const relay = (await txn.get<RelayState>(RELAY_KEY)) ?? {
        publicationId: null,
        resources: {},
      };
      if (!this.room) return { ok: false, code: "ROOM_NOT_FOUND" };
      const owner = findMember(this.room, resource.ownerId);
      if (
        !owner ||
        (resource.publicationId === null && owner.role !== "host")
      ) {
        return { ok: false, code: "FORBIDDEN" };
      }
      if (
        resource.publicationId !== null &&
        (!this.room.stream.live ||
          relay.publicationId !== resource.publicationId)
      ) {
        return { ok: false, code: "STREAM_NOT_LIVE" };
      }
      relay.resources[resource.id] = resource;
      if (resource.publicationId === null) relay.publicationId = resource.id;
      await txn.put(RELAY_KEY, relay);
      return { ok: true, value: null };
    });
  }

  async getRelayResource(id: string): Promise<RelayResource | null> {
    const relay = await this.ctx.storage.get<RelayState>(RELAY_KEY);
    return relay && Object.hasOwn(relay.resources, id)
      ? (relay.resources[id] ?? null)
      : null;
  }

  async removeRelayResource(id: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const relay = await txn.get<RelayState>(RELAY_KEY);
      if (!relay || !Object.hasOwn(relay.resources, id)) return;
      delete relay.resources[id];
      if (relay.publicationId === id) relay.publicationId = null;
      await txn.put(RELAY_KEY, relay);
    });
  }

  async closeRelayResources(): Promise<void> {
    const relay = await this.ctx.storage.get<RelayState>(RELAY_KEY);
    if (!relay || !Object.keys(relay.resources).length) return;
    const realtime = createRealtime(this.env);
    for (const resource of Object.values(relay.resources)) {
      await realtime.closeTracks(
        resource.sessionId,
        resource.tracks.map(({ mid }) => mid),
      );
      await this.removeRelayResource(resource.id);
    }
  }

  async init(input: {
    roomId: string;
    inviteCode: string;
    nickname: string;
  }): Promise<{ hostToken: string; memberId: string }> {
    if (this.room || this.closing) throw new Error("房間已初始化");
    const hostToken = generateToken();
    const memberId = generateId();
    this.room = createRoomState({
      roomId: input.roomId,
      inviteCode: input.inviteCode,
      host: {
        memberId,
        nickname: input.nickname,
        tokenHash: await hashToken(hostToken),
      },
      now: Date.now(),
    });
    await this.save();
    return { hostToken, memberId };
  }

  async join(input: {
    inviteCode: string;
    nickname: string;
  }): Promise<Result<{ memberToken: string; memberId: string }>> {
    if (!this.room) return { ok: false, code: "ROOM_NOT_FOUND" };
    const memberToken = generateToken();
    const memberId = generateId();
    const tokenHash = await hashToken(memberToken);
    if (!this.room) return { ok: false, code: "ROOM_NOT_FOUND" };
    const outcome = addMember(
      this.room,
      {
        inviteCode: input.inviteCode,
        member: { memberId, nickname: input.nickname, tokenHash },
      },
      this.online(),
      Date.now(),
      this.config,
    );
    if (!outcome.ok) return outcome;
    this.room = outcome.state;
    await this.save();
    return { ok: true, value: { memberToken, memberId } };
  }

  async authenticate(
    token: string,
  ): Promise<Result<{ memberId: string; role: Role }>> {
    const tokenHash = await hashToken(token);
    const member = this.room && findMemberByTokenHash(this.room, tokenHash);
    if (!member) return { ok: false, code: "UNAUTHORIZED" };
    return {
      ok: true,
      value: { memberId: member.memberId, role: member.role },
    };
  }

  async regenerateInviteCode(
    hostMemberId: string,
  ): Promise<Result<{ inviteCode: string }>> {
    // 呼叫 InviteDirectoryDO 期間其他請求可能進來；兩次重產交錯會讓其中一個回傳的碼失效、
    // 並在對照表留下孤兒，所以和關房一起排隊。
    return this.exclusive(() => this.regenerateInviteCodeNow(hostMemberId));
  }

  private async regenerateInviteCodeNow(
    hostMemberId: string,
  ): Promise<Result<{ inviteCode: string }>> {
    if (!this.room) return { ok: false, code: "ROOM_NOT_FOUND" };
    if (findMember(this.room, hostMemberId)?.role !== "host") {
      return { ok: false, code: "FORBIDDEN" };
    }
    const { roomId } = this.room;
    const directory = this.directory();
    const inviteCode = await directory.replace(this.room.inviteCode, roomId);
    if (!this.room) {
      // 不應發生（關房也在佇列裡），保險起見不留下孤兒。
      await directory.release(inviteCode, roomId);
      return { ok: false, code: "ROOM_NOT_FOUND" };
    }
    this.room = { ...this.room, inviteCode };
    await this.save();
    // 只有房主看得到邀請碼。
    this.apply(
      [
        {
          kind: "send",
          to: { memberId: hostMemberId },
          message: {
            type: "room:updated",
            room: toRoomInfo(this.room, "host"),
          },
        },
      ],
      null,
    );
    return { ok: true, value: { inviteCode } };
  }

  // ── WebSocket ──────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (!this.room) {
      return Response.json(errorBody("ROOM_NOT_FOUND"), { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(errorBody("BAD_REQUEST"), { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = {
      memberId: null,
      authDeadline: Date.now() + this.config.authTimeoutMs,
    };
    server.serializeAttachment(attachment);
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const attachment = this.attachmentOf(ws);
    if (!this.room || !attachment) return;
    if (typeof data !== "string") {
      closeSocket(ws, CLOSE.BAD_REQUEST, "binary_not_supported");
      return;
    }
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      if (attachment.memberId === null) {
        closeSocket(ws, CLOSE.BAD_REQUEST, "bad_request");
        return;
      }
      this.sendTo(ws, {
        type: "error",
        code: "BAD_REQUEST",
        message: parsed.error,
      });
      return;
    }
    const message = parsed.message;

    if (attachment.memberId === null) {
      if (message.type !== "auth") {
        closeSocket(ws, CLOSE.BAD_REQUEST, "auth_required");
        return;
      }
      const tokenHash = await hashToken(message.token);
      // 雜湊期間連線可能已被關閉、取代或用另一則 auth 驗證過；期限以雜湊完成的時間判斷。
      const current = this.attachmentOf(ws);
      if (
        !this.room ||
        current?.memberId !== null ||
        current.authDeadline === 0
      ) {
        return;
      }
      const now = Date.now();
      if (now > current.authDeadline) {
        closeSocket(ws, CLOSE.AUTH_TIMEOUT, "auth_timeout");
        return;
      }
      const outcome = onAuth(
        this.room,
        {
          tokenHash,
          protocolVersion: message.protocolVersion,
          reqId: message.reqId,
        },
        PROTOCOL_VERSION,
        this.online(),
        now,
      );
      if (outcome.accepted) {
        // 同一成員的舊連線（例如另一個分頁）由新連線取代。
        for (const other of this.socketsOf(outcome.memberId)) {
          other.serializeAttachment({
            memberId: null,
            authDeadline: 0,
          } satisfies Attachment);
          closeSocket(other, CLOSE.REPLACED, "replaced");
        }
        ws.serializeAttachment({
          memberId: outcome.memberId,
          authDeadline: 0,
        } satisfies Attachment);
        this.room = outcome.state;
        await this.save();
      }
      this.apply(outcome.effects, ws);
      return;
    }

    if (message.type === "auth") {
      this.sendTo(ws, {
        type: "error",
        code: "BAD_REQUEST",
        message: "已經驗證過",
      });
      return;
    }
    const before = this.room;
    const outcome = onMessage(
      this.room,
      attachment.memberId,
      message,
      this.online(),
      Date.now(),
    );
    this.room = outcome.state;
    if (outcome.state !== before) await this.save();
    this.apply(outcome.effects, ws);
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    await this.handleSocketGone(ws, code);
  }

  override async webSocketError(ws: WebSocket) {
    await this.handleSocketGone(ws, 1011);
  }

  // ── 關房 ───────────────────────────────────────────────────

  /**
   * 同一個 alarm 有三種用途：關房（閒置或到期）、關掉逾時未驗證的連線、重試關房清理。
   * 每次執行完都依目前狀態重新排下一次（scheduleAlarm 取最早的時間）。
   */
  override async alarm() {
    if (this.closing) {
      await this.exclusive(() => this.finishClose());
      return;
    }
    const now = Date.now();
    if (this.room && now >= closeAt(this.room, this.config)) {
      await this.closeRoom("expired");
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(ws);
      if (
        attachment?.memberId === null &&
        attachment.authDeadline > 0 &&
        now > attachment.authDeadline
      ) {
        closeSocket(ws, CLOSE.AUTH_TIMEOUT, "auth_timeout");
      }
    }
    await this.scheduleAlarm();
  }

  private closeRoom(reason: CloseReason) {
    return this.exclusive(async () => {
      const room = this.room;
      if (!room) return;
      this.apply(closeRoomEffects(this.online(), reason), null);
      for (const ws of this.ctx.getWebSockets()) {
        closeSocket(ws, CLOSE.ROOM_CLOSED, reason);
      }
      // 先在 storage 記下「關房中」並刪掉房間狀態（同一筆交易），
      // 之後清理外部資源失敗、甚至 DO 重啟，alarm 都能接著重試。
      const closing: Closing = {
        roomId: room.roomId,
        inviteCode: room.inviteCode,
        reason,
        attempts: 0,
      };
      this.room = null;
      this.closing = closing;
      await this.ctx.storage.transaction(async (txn) => {
        await txn.delete(STATE_KEY);
        await txn.put(CLOSING_KEY, closing);
      });
      console.log(JSON.stringify({ event: "room.closed", reason }));
      await this.finishClose();
    });
  }

  /** 釋放邀請碼、關掉轉發 tracks；全部成功才刪除 storage。失敗就排 alarm 重試。 */
  private async finishClose() {
    const closing = this.closing;
    if (!closing) return;
    try {
      await this.directory().release(closing.inviteCode, closing.roomId);
      await this.closeRelayResources();
    } catch {
      const attempts = closing.attempts + 1;
      if (attempts < CLEANUP_MAX_ATTEMPTS) {
        this.closing = { ...closing, attempts };
        await this.ctx.storage.put(CLOSING_KEY, this.closing);
        const delay = Math.min(
          CLEANUP_RETRY_MAX_MS,
          CLEANUP_RETRY_BASE_MS * 2 ** (attempts - 1),
        );
        await this.ctx.storage.setAlarm(Date.now() + delay);
        console.log(
          JSON.stringify({ event: "room.cleanup_retry", attempts, delay }),
        );
        return;
      }
      console.log(JSON.stringify({ event: "room.cleanup_gave_up", attempts }));
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.closing = null;
  }

  // ── 工具 ───────────────────────────────────────────────────

  private async handleSocketGone(ws: WebSocket, code: number) {
    closeSocket(ws, code === 1005 || code === 1006 ? 1000 : code, "bye");
    const memberId = this.attachmentOf(ws)?.memberId;
    if (!this.room || !memberId) return;
    const outcome = onDisconnect(
      this.room,
      memberId,
      this.online(ws),
      Date.now(),
    );
    this.room = outcome.state;
    await this.save();
    this.apply(outcome.effects, null);
  }

  private directory() {
    return this.env.INVITE_DIRECTORY.getByName(INVITE_DIRECTORY_NAME);
  }

  /** 依序執行：前一個結束（不論成功或失敗）才開始下一個。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private attachmentOf(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private socketsOf(memberId: string) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => this.attachmentOf(ws)?.memberId === memberId);
  }

  /** 目前在線（已驗證）的成員；`exclude` 用於「這條連線關閉後」的情況。 */
  private online(exclude?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const memberId = this.attachmentOf(ws)?.memberId;
      if (memberId) ids.add(memberId);
    }
    return ids;
  }

  private sendTo(ws: WebSocket, message: unknown) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // 連線已關閉，忽略
    }
  }

  private apply(effects: Effect[], conn: WebSocket | null) {
    for (const effect of effects) {
      const targets =
        "conn" in effect.to
          ? conn
            ? [conn]
            : []
          : this.socketsOf(effect.to.memberId);
      for (const ws of targets) {
        if (effect.kind === "send") this.sendTo(ws, effect.message);
        else closeSocket(ws, effect.code, effect.reason);
      }
    }
  }

  private async save() {
    if (!this.room) return;
    await this.ctx.storage.put(STATE_KEY, this.room);
    await this.scheduleAlarm();
  }

  private async scheduleAlarm() {
    if (!this.room) return;
    let next = closeAt(this.room, this.config);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(ws);
      if (attachment?.memberId === null && attachment.authDeadline > 0) {
        next = Math.min(next, attachment.authDeadline + 100);
      }
    }
    await this.ctx.storage.setAlarm(next);
  }
}

function closeSocket(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // 已經關閉
  }
}
