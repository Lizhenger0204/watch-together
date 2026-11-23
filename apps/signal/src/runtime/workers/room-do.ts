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
import { roomClosedSocket } from "./room-closed-socket";

type Attachment = { memberId: string | null; authDeadline: number };

const STATE_KEY = "state";
const RELAY_KEY = "relay";
/** 進行中的換碼：邀請目錄可能已換好但回應遺失，之後用同一個 opId 查回結果。 */
const ROTATION_KEY = "rotation";
/** 房間已關閉，記錄還沒在邀請目錄釋放的東西。存在時房間已不可用。 */
const CLOSING_KEY = "closing";
/** 清理外部資源（邀請碼、轉發 tracks）的重試排程。 */
const RETRY_KEY = "retry";

type Rotation = { opId: string; from: string };
type CloseReason = "expired" | "host_closed";
type Closing = {
  roomId: string;
  reason: CloseReason;
  /** 還沒釋放的邀請碼。 */
  inviteCodes: string[];
  /** 關房時還沒確認結果的換碼；先查回換到的碼，才釋放邀請碼。 */
  rotation: Rotation | null;
};
/** `attempts`：已經失敗的輪數（含第一次）。`at` 為 null 表示已放棄。 */
type Retry = { attempts: number; at: number | null };
/** 清理失敗的重試間隔：30 秒起跳、每次加倍、最多 1 小時；含第一次最多嘗試 12 次。 */
const CLEANUP_RETRY_BASE_MS = 30_000;
const CLEANUP_RETRY_MAX_MS = 60 * 60_000;
const CLEANUP_MAX_ATTEMPTS = 12;
type RelayState = {
  publicationId: string | null;
  resources: Record<string, RelayResource>;
  /** 登記被拒、回滾也失敗的 tracks，等 alarm 關掉。 */
  orphans: Record<string, RelayResource>;
};

function readRelay(stored: RelayState | undefined): RelayState {
  return {
    publicationId: stored?.publicationId ?? null,
    resources: stored?.resources ?? {},
    orphans: stored?.orphans ?? {},
  };
}

/**
 * 每個房間一個實例。使用 WebSocket Hibernation API：
 * DO 可能隨時休眠，記憶體會清空，所以狀態一律寫進 storage，計時一律用 alarm。
 */
export class RoomDO extends DurableObject<Env> {
  private room: RoomState | null = null;
  private closing: Closing | null = null;
  private retry: Retry | null = null;
  /** 會呼叫外部服務的操作（重產邀請碼、關房、清理）依序執行，見 exclusive()。 */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: RoomConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readRoomConfig(env as unknown as Record<string, unknown>);
    void ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
      this.closing = (await ctx.storage.get<Closing>(CLOSING_KEY)) ?? null;
      this.retry = (await ctx.storage.get<Retry>(RETRY_KEY)) ?? null;
    });
  }

  // ── RPC（由 Worker 呼叫）──────────────────────────────────

  async getRelayPublication(): Promise<RelayResource | null> {
    const relay = readRelay(await this.ctx.storage.get<RelayState>(RELAY_KEY));
    if (!this.room?.stream.live || !relay.publicationId) return null;
    return relay.resources[relay.publicationId] ?? null;
  }

  async registerRelayResource(resource: RelayResource): Promise<Result<null>> {
    return this.ctx.storage.transaction(async (txn) => {
      const relay = readRelay(await txn.get<RelayState>(RELAY_KEY));
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
      const stored = await txn.get<RelayState>(RELAY_KEY);
      if (!stored) return;
      const relay = readRelay(stored);
      if (
        !Object.hasOwn(relay.resources, id) &&
        !Object.hasOwn(relay.orphans, id)
      )
        return;
      delete relay.resources[id];
      delete relay.orphans[id];
      if (relay.publicationId === id) relay.publicationId = null;
      await txn.put(RELAY_KEY, relay);
    });
  }

  /**
   * WHIP／WHEP 登記被拒（例如房間剛關閉）且回滾也失敗時，把 tracks 記成清理待辦，
   * 由 alarm 重試關閉。房間不論開著、關房中或已清空都收。
   */
  async retainRelayCleanup(resource: RelayResource): Promise<void> {
    await this.exclusive(async () => {
      await this.ctx.storage.transaction(async (txn) => {
        const relay = readRelay(await txn.get<RelayState>(RELAY_KEY));
        relay.orphans[resource.id] = resource;
        await txn.put(RELAY_KEY, relay);
      });
      if (!this.retry || this.retry.at === null) {
        this.retry = { attempts: 0, at: Date.now() + CLEANUP_RETRY_BASE_MS };
        await this.ctx.storage.put(RETRY_KEY, this.retry);
      }
      await this.scheduleAlarm();
    });
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
    // 和關房一起排隊：依序執行時最後一次換到的碼有效，對照表不留孤兒。
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
    // 上次換碼的回應遺失：用同一個 opId 查回當時換到的碼，先套用。
    const unfinished = await this.ctx.storage.get<Rotation>(ROTATION_KEY);
    if (unfinished) {
      await this.applyRotation(
        await directory.replace(unfinished.from, roomId, unfinished.opId),
      );
    }
    const rotation: Rotation = {
      opId: generateId(),
      from: this.openRoom().inviteCode,
    };
    await this.ctx.storage.put(ROTATION_KEY, rotation);
    const inviteCode = await directory.replace(
      rotation.from,
      roomId,
      rotation.opId,
    );
    await this.applyRotation(inviteCode);
    // 只有房主看得到邀請碼。
    this.apply(
      [
        {
          kind: "send",
          to: { memberId: hostMemberId },
          message: {
            type: "room:updated",
            room: toRoomInfo(this.openRoom(), "host"),
          },
        },
      ],
      null,
    );
    return { ok: true, value: { inviteCode } };
  }

  /** 換碼完成：記下新碼並清掉進行中的換碼紀錄（同一筆交易）。 */
  private async applyRotation(inviteCode: string) {
    const room = { ...this.openRoom(), inviteCode };
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(STATE_KEY, room);
      await txn.delete(ROTATION_KEY);
    });
    this.room = room;
  }

  /** 排在佇列裡的操作用：關房也在同一個佇列，所以執行期間房間不會消失。 */
  private openRoom(): RoomState {
    if (!this.room) throw new Error("房間已關閉");
    return this.room;
  }

  // ── WebSocket ──────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const upgrade =
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (!this.room) {
      // 不存在、已關閉、關房中都一樣；不碰 storage 與 alarm。
      return upgrade
        ? roomClosedSocket()
        : Response.json(errorBody("ROOM_NOT_FOUND"), { status: 404 });
    }
    if (!upgrade) {
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
   * 同一個 alarm 有三種用途：重試清理、關房（閒置或到期）、關掉逾時未驗證的連線。
   * 每次執行完都依目前狀態重新排下一次（scheduleAlarm 取最早的時間）。
   */
  override async alarm() {
    const now = Date.now();
    // 房間已關閉時，alarm 只會是為了清理而排的，響了就做。
    if (this.retry?.at != null && (now >= this.retry.at || !this.room)) {
      await this.exclusive(() => this.runCleanup());
    }
    if (this.room && now >= closeAt(this.room, this.config)) {
      await this.closeRoom("expired");
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
      // 排隊期間房間可能有新的活動（例如房主重新連線），用取得執行權時的狀態重算期限。
      if (reason === "expired" && Date.now() < closeAt(room, this.config)) {
        return;
      }
      const closing: Closing = {
        roomId: room.roomId,
        reason,
        inviteCodes: [room.inviteCode],
        rotation: (await this.ctx.storage.get<Rotation>(ROTATION_KEY)) ?? null,
      };
      const retry: Retry = { attempts: 0, at: Date.now() };
      // 先提交「已關房」再通知與斷線：提交失敗時房間維持原狀，下次 alarm 再關。
      // 之後清理外部資源失敗、甚至 DO 重啟，alarm 都能接著重試。
      await this.ctx.storage.transaction(async (txn) => {
        await txn.delete(STATE_KEY);
        await txn.delete(ROTATION_KEY);
        await txn.put(CLOSING_KEY, closing);
        await txn.put(RETRY_KEY, retry);
      });
      const online = this.online();
      this.room = null;
      this.closing = closing;
      this.retry = retry;
      this.apply(closeRoomEffects(online, reason), null);
      for (const ws of this.ctx.getWebSockets()) {
        closeSocket(ws, CLOSE.ROOM_CLOSED, reason);
      }
      console.log(JSON.stringify({ event: "room.closed", reason }));
      await this.runCleanup();
    });
  }

  /**
   * 清理外部資源：關房後是邀請碼與全部轉發 tracks，房間開著時只有登記失敗的 tracks。
   * 邀請碼與每個轉發資源各自嘗試、完成一項就保存一項，互不阻擋。
   * 有沒做完的就排 alarm 重試；含第一次失敗滿 12 次就放棄，保留沒做完的紀錄。
   * 只能在 exclusive() 裡呼叫。
   */
  private async runCleanup() {
    if (this.closing) await this.releaseInviteCodes();
    const relayLeft = await this.closeRelayTracks(this.closing !== null);
    const inviteLeft = this.closing
      ? this.closing.inviteCodes.length + (this.closing.rotation ? 1 : 0)
      : 0;

    if (relayLeft + inviteLeft === 0) {
      this.retry = null;
      if (!this.room) {
        // 房間已關閉且全部清乾淨：刪掉整個 DO 的資料。
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.closing = null;
        return;
      }
      await this.ctx.storage.delete(RETRY_KEY);
      await this.scheduleAlarm();
      return;
    }

    const attempts = (this.retry?.attempts ?? 0) + 1;
    if (attempts >= CLEANUP_MAX_ATTEMPTS) {
      this.retry = { attempts, at: null };
      console.log(
        JSON.stringify({
          event: "room.cleanup_gave_up",
          attempts,
          inviteLeft,
          relayLeft,
        }),
      );
    } else {
      const delay = Math.min(
        CLEANUP_RETRY_MAX_MS,
        CLEANUP_RETRY_BASE_MS * 2 ** (attempts - 1),
      );
      this.retry = { attempts, at: Date.now() + delay };
      console.log(
        JSON.stringify({ event: "room.cleanup_retry", attempts, delay }),
      );
    }
    await this.ctx.storage.put(RETRY_KEY, this.retry);
    await this.scheduleAlarm();
  }

  /** 先查回未確認的換碼結果，再逐一釋放邀請碼；每完成一步就寫回 closing。 */
  private async releaseInviteCodes() {
    const directory = this.directory();
    let closing = this.closing;
    if (!closing) return;
    if (closing.rotation) {
      const { from, opId } = closing.rotation;
      try {
        const code = await directory.replace(from, closing.roomId, opId);
        closing = {
          ...closing,
          inviteCodes: [...closing.inviteCodes, code],
          rotation: null,
        };
        await this.saveClosing(closing);
      } catch {
        // 換碼結果還查不到就先不釋放：release 會刪掉目錄裡的換碼紀錄，之後就查不回來了。
        return;
      }
    }
    for (const code of closing.inviteCodes) {
      try {
        await directory.release(code, closing.roomId);
      } catch {
        continue;
      }
      closing = {
        ...closing,
        inviteCodes: closing.inviteCodes.filter((c) => c !== code),
      };
      await this.saveClosing(closing);
    }
  }

  private async saveClosing(closing: Closing) {
    await this.ctx.storage.put(CLOSING_KEY, closing);
    this.closing = closing;
  }

  /** 逐一關閉轉發 tracks，成功一個就從 storage 移除一個。回傳還沒關掉的數量。 */
  private async closeRelayTracks(includeActive: boolean): Promise<number> {
    const relay = readRelay(await this.ctx.storage.get<RelayState>(RELAY_KEY));
    const targets = [
      ...Object.values(relay.orphans),
      ...(includeActive ? Object.values(relay.resources) : []),
    ];
    if (!targets.length) return 0;
    let realtime: ReturnType<typeof createRealtime>;
    try {
      realtime = createRealtime(this.env);
    } catch {
      return targets.length; // 沒有 Realtime 憑證：留著，之後重試
    }
    let left = 0;
    for (const resource of targets) {
      try {
        await realtime.closeTracks(
          resource.sessionId,
          resource.tracks.map(({ mid }) => mid),
        );
      } catch {
        left += 1;
        continue;
      }
      await this.removeRelayResource(resource.id);
    }
    return left;
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
    let next = Infinity;
    if (this.room) {
      next = closeAt(this.room, this.config);
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = this.attachmentOf(ws);
        if (attachment?.memberId === null && attachment.authDeadline > 0) {
          next = Math.min(next, attachment.authDeadline + 100);
        }
      }
    }
    if (this.retry?.at != null) next = Math.min(next, this.retry.at);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}

/** 關閉連線。未驗證的連線一併清掉 auth 期限，之後不再為它排 alarm。 */
function closeSocket(ws: WebSocket, code: number, reason: string) {
  try {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.memberId === null && attachment.authDeadline > 0) {
      ws.serializeAttachment({
        memberId: null,
        authDeadline: 0,
      } satisfies Attachment);
    }
  } catch {
    // 連線已不可用，附件寫不進去也無妨
  }
  try {
    ws.close(code, reason);
  } catch {
    // 已經關閉
  }
}
