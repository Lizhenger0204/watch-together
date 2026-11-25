import { PROTOCOL_VERSION, parseClientMessage } from "@project/shared";
import { DurableObject } from "cloudflare:workers";
import type { RoomMember } from "../../app";
import { readRoomConfig, type RoomConfig } from "../../config";
import { errorBody, type Result } from "../../errors";
import type { RelayResource } from "../../relay";
import {
  readRelay,
  saveRelay,
  registerResource,
  retireRoomResources,
  closeResources,
  removeResource,
} from "./room-relay";
import { generateId, generateToken, hashToken } from "../../room/crypto";
import {
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

import {
  acceptMember,
  attachmentOf,
  closeSocket,
  authTimeouts,
  onlineMembers,
  socketsOf,
  type Attachment,
} from "./room-sockets";
import { joinMember, reuseMember, type JoinInput } from "./room-join";
import { SerialQueue } from "./serial-queue";

const STATE_KEY = "state";
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
/**
 * 每個房間一個實例。使用 WebSocket Hibernation API：
 * DO 可能隨時休眠，記憶體會清空，所以狀態一律寫進 storage，計時一律用 alarm。
 */
export class RoomDO extends DurableObject<Env> {
  private room: RoomState | null = null;
  private closing: Closing | null = null;
  // 房態工作只等本機交易；等待目錄或 SFU 的生命週期工作可在回來後排入房態佇列。
  // 房態工作只能透過 waitUntil 派送後續清理，不能反向等待生命週期佇列。
  private readonly changes = new SerialQueue();
  private readonly lifecycle = new SerialQueue();
  private readonly config: RoomConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readRoomConfig(env as unknown as Record<string, unknown>);
    void ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
      this.closing = (await ctx.storage.get<Closing>(CLOSING_KEY)) ?? null;
      await ctx.storage.transaction(async (txn) => {
        const saved = await txn.get<Retry>(RETRY_KEY);
        if (saved?.at === null) return;
        if (!saved && !this.closing) {
          if (!Object.keys((await readRelay(txn)).orphans).length) return;
        }
        // 舊版可能已寫入待辦才中斷；喚醒時補排，保留已累積的嘗試次數。
        const retry = saved ?? {
          attempts: 0,
          at: Date.now() + CLEANUP_RETRY_BASE_MS,
        };
        if (!saved) await txn.put(RETRY_KEY, retry);
        await this.writeAlarm(txn, retry);
      });
    });
  }

  // ── RPC（由 Worker 呼叫）──────────────────────────────────

  async getRelayPublication(): Promise<RelayResource | null> {
    return this.changes.run(async () => {
      const relay = await readRelay(this.ctx.storage);
      if (
        this.room?.mode !== "relay" ||
        !this.room.stream.live ||
        !relay.publicationId
      )
        return null;
      return relay.resources[relay.publicationId] ?? null;
    });
  }

  async registerRelayResource(resource: RelayResource): Promise<Result<null>> {
    return this.changes.run(async () => {
      const result = await this.ctx.storage.transaction(async (txn) => {
        const room = await txn.get<RoomState>(STATE_KEY);
        const registration = await registerResource(txn, room, resource);
        if (registration.ok && registration.value.length)
          await this.armCleanup(txn, this.room);
        return registration;
      });
      if (!result.ok) return result;
      this.closeRetired(result.value);
      return { ok: true, value: null };
    });
  }

  async getRelayResource(id: string): Promise<RelayResource | null> {
    const relay = await readRelay(this.ctx.storage);
    return Object.hasOwn(relay.resources, id)
      ? (relay.resources[id] ?? null)
      : null;
  }

  async removeRelayResource(id: string): Promise<void> {
    await this.changes.run(() => removeResource(this.ctx.storage, id));
  }

  async retainRelayCleanup(resource: RelayResource): Promise<void> {
    await this.lifecycle.run(() =>
      this.changes.run(() =>
        this.ctx.storage.transaction(async (txn) => {
          const relay = await readRelay(txn);
          relay.orphans[resource.id] = resource;
          await saveRelay(txn, relay);
          await this.armCleanup(txn, this.room);
        }),
      ),
    );
  }

  private async armCleanup(
    txn: DurableObjectTransaction,
    room: RoomState | null,
  ) {
    const current = await txn.get<Retry>(RETRY_KEY);
    const retry =
      current?.at != null
        ? current
        : { attempts: 1, at: Date.now() + CLEANUP_RETRY_BASE_MS };
    await txn.put(RETRY_KEY, retry);
    await this.writeAlarm(txn, retry, room);
  }

  private closeRetired(retired: RelayResource[]) {
    if (!retired.length) return;
    // 待辦與 alarm 已提交；慢速 SFU 不阻塞房間通知與新發布的回應。
    this.ctx.waitUntil(
      this.lifecycle.run(async () => {
        const left = await this.closeTracks(retired);
        if (!left && this.room)
          await this.changes.run(() => this.clearCompletedRetry());
      }),
    );
  }

  private async clearCompletedRetry() {
    await this.ctx.storage.transaction(async (txn) => {
      // 關閉上游期間，另一次踢人或發布可能已加入新的待辦。
      if (Object.keys((await readRelay(txn)).orphans).length) return;
      await txn.delete(RETRY_KEY);
      await this.writeAlarm(txn, null);
    });
  }

  async init(input: {
    roomId: string;
    inviteCode: string;
    nickname: string;
  }): Promise<{ hostToken: string; memberId: string }> {
    const hostToken = generateToken();
    const memberId = generateId();
    const tokenHash = await hashToken(hostToken);
    return this.changes.run(async () => {
      if (this.room || this.closing) throw new Error("房間已初始化");
      const room = createRoomState({
        roomId: input.roomId,
        inviteCode: input.inviteCode,
        host: {
          memberId,
          nickname: input.nickname,
          tokenHash,
        },
        now: Date.now(),
      });
      await this.saveTransition(room);
      return { hostToken, memberId };
    });
  }

  reuseMember(inviteCode: string, token: string) {
    return reuseMember(() => this.room, inviteCode, token);
  }

  join(input: JoinInput) {
    return joinMember(
      {
        room: () => this.room,
        changes: this.changes,
        online: () => this.online(),
        save: (next) => this.saveTransition(next),
        config: this.config,
      },
      input,
    );
  }

  async authenticate(
    token: string,
  ): Promise<Result<Omit<RoomMember, "roomId">>> {
    const tokenHash = await hashToken(token);
    const room = this.room;
    const member = room && findMemberByTokenHash(room, tokenHash);
    if (!member) return { ok: false, code: "UNAUTHORIZED" };
    return {
      ok: true,
      value: {
        memberId: member.memberId,
        role: member.role,
        mode: room.mode,
        relayGeneration: member.relayGeneration ?? 0,
      },
    };
  }

  async regenerateInviteCode(
    hostMemberId: string,
  ): Promise<Result<{ inviteCode: string }>> {
    // 和關房一起排隊：依序執行時最後一次換到的碼有效，對照表不留孤兒。
    return this.lifecycle.run(() => this.regenerateInviteCodeNow(hostMemberId));
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
    await this.applyRotation(inviteCode, hostMemberId);
    return { ok: true, value: { inviteCode } };
  }

  /** 換碼完成：記下新碼並清掉進行中的換碼紀錄（同一筆交易）。 */
  private async applyRotation(inviteCode: string, hostMemberId?: string) {
    await this.changes.run(async () => {
      const room = { ...this.openRoom(), inviteCode };
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(STATE_KEY, room);
        await txn.delete(ROTATION_KEY);
      });
      this.room = room;
      if (hostMemberId) {
        // 只有房主看得到邀請碼。
        this.apply(
          [
            {
              kind: "send",
              to: { memberId: hostMemberId },
              message: {
                type: "room:updated",
                room: toRoomInfo(room, "host"),
              },
            },
          ],
          null,
        );
      }
    });
  }

  /** 排在佇列裡的操作用：關房也在同一個佇列，所以執行期間房間不會消失。 */
  private openRoom(): RoomState {
    if (!this.room) throw new Error("房間已關閉");
    return this.room;
  }

  // ── WebSocket ──────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    return this.changes.run(async () => {
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
      const attachment: Attachment = {
        memberId: null,
        authDeadline: Date.now() + this.config.authTimeoutMs,
      };
      await this.scheduleAlarm(
        authTimeouts(this.ctx, { openingDeadline: attachment.authDeadline })
          .alarm,
      );
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(attachment);
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    return this.changes.run(() => this.handleMessage(ws, data));
  }

  private async handleMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const attachment = attachmentOf(ws);
    if (
      !this.room ||
      !attachment ||
      (attachment.memberId === null && !attachment.authDeadline)
    )
      return;
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
      const now = Date.now();
      if (now > attachment.authDeadline) {
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
        await this.saveTransition(outcome.state, { accepted: ws });
        acceptMember(this.ctx, ws, outcome.memberId);
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
    if (outcome.state !== before) await this.saveTransition(outcome.state);
    this.apply(outcome.effects, ws);
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    await this.changes.run(() => this.handleSocketGone(ws, code));
  }

  override async webSocketError(ws: WebSocket) {
    await this.changes.run(() => this.handleSocketGone(ws, 1011));
  }

  // ── 關房 ───────────────────────────────────────────────────

  /**
   * 同一個 alarm 有三種用途：重試清理、關房（閒置或到期）、關掉逾時未驗證的連線。
   * 每次執行完都依目前狀態重新排下一次（scheduleAlarm 取最早的時間）。
   */
  override async alarm() {
    const retry = await this.ctx.storage.get<Retry>(RETRY_KEY);
    const now = Date.now();
    if (
      (retry?.at != null && now >= retry.at) ||
      (this.room && now >= closeAt(this.room, this.config))
    ) {
      await this.lifecycle.run(async () => {
        // 等候目錄或清理期間仍可重新上線，執行前再確認兩種期限。
        const current = await this.ctx.storage.get<Retry>(RETRY_KEY);
        if (current?.at != null && Date.now() >= current.at)
          await this.runCleanup();
        if (await this.changes.run(() => this.closeIfExpired()))
          await this.runCleanup();
      });
    }
    await this.changes.run(async () => {
      const { alarm, expired } = authTimeouts(this.ctx, { now: Date.now() });
      await this.scheduleAlarm(alarm);
      for (const ws of expired)
        closeSocket(ws, CLOSE.AUTH_TIMEOUT, "auth_timeout");
    });
  }

  private async closeIfExpired() {
    const room = this.room;
    if (!room || Date.now() < closeAt(room, this.config)) return false;
    const reason = "expired";
    const closing: Closing = {
      roomId: room.roomId,
      reason,
      inviteCodes: [room.inviteCode],
      rotation: (await this.ctx.storage.get<Rotation>(ROTATION_KEY)) ?? null,
    };
    const retry = { attempts: 0, at: Date.now() };
    // 先提交「已關房」再通知與斷線：提交失敗時房間維持原狀，下次 alarm 再關。
    // 之後清理外部資源失敗、甚至 DO 重啟，alarm 都能接著重試。
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(STATE_KEY);
      await txn.delete(ROTATION_KEY);
      await txn.put(CLOSING_KEY, closing);
      await txn.put(RETRY_KEY, retry);
      await txn.setAlarm(retry.at);
    });
    const online = this.online();
    this.room = null;
    this.closing = closing;
    this.apply(closeRoomEffects(online, reason), null);
    for (const ws of this.ctx.getWebSockets()) {
      closeSocket(ws, CLOSE.ROOM_CLOSED, reason);
    }
    console.log(JSON.stringify({ event: "room.closed", reason }));
    return true;
  }

  /**
   * 清理外部資源：關房後是邀請碼與全部轉發 tracks，房間開著時只清理已撤下或登記失敗的 tracks。
   * 邀請碼與每個轉發資源各自嘗試、完成一項就保存一項，互不阻擋。
   * 有沒做完的就排 alarm 重試；含第一次失敗滿 12 次就放棄，保留沒做完的紀錄。
   * 只能由生命週期佇列呼叫。
   */
  private async runCleanup() {
    if (this.closing) await this.releaseInviteCodes();
    const relay = await readRelay(this.ctx.storage);
    const targets = Object.values(relay.orphans);
    if (this.closing) targets.push(...Object.values(relay.resources));
    const relayLeft = await this.closeTracks(targets);
    await this.changes.run(() => this.finishCleanup(relayLeft));
  }

  private closeTracks(targets: RelayResource[]) {
    return closeResources(this.env, targets, (id) =>
      this.removeRelayResource(id),
    );
  }

  private async finishCleanup(relayLeft: number) {
    const inviteLeft = this.closing
      ? this.closing.inviteCodes.length + (this.closing.rotation ? 1 : 0)
      : 0;

    if (relayLeft + inviteLeft === 0) {
      if (!this.room) {
        // 房間已關閉且全部清乾淨：刪掉整個 DO 的資料。
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.closing = null;
        return;
      }
      await this.clearCompletedRetry();
      return;
    }

    const current = await this.ctx.storage.get<Retry>(RETRY_KEY);
    const attempts = (current?.attempts ?? 0) + 1;
    const delay = Math.min(
      CLEANUP_RETRY_MAX_MS,
      CLEANUP_RETRY_BASE_MS * 2 ** (attempts - 1),
    );
    const retry: Retry = {
      attempts,
      at: attempts >= CLEANUP_MAX_ATTEMPTS ? null : Date.now() + delay,
    };
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(RETRY_KEY, retry);
      await this.writeAlarm(txn, retry);
    });
    console.log(
      JSON.stringify(
        retry.at === null
          ? { event: "room.cleanup_gave_up", attempts, inviteLeft, relayLeft }
          : { event: "room.cleanup_retry", attempts, delay },
      ),
    );
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

  // ── 工具 ───────────────────────────────────────────────────

  private async handleSocketGone(ws: WebSocket, code: number) {
    const memberId = attachmentOf(ws)?.memberId;
    if (this.room && memberId) {
      const outcome = onDisconnect(
        this.room,
        memberId,
        this.online(ws),
        Date.now(),
      );
      if (outcome.state !== this.room)
        await this.saveTransition(outcome.state, { departed: memberId });
      ws.serializeAttachment({
        memberId: null,
        authDeadline: 0,
      } satisfies Attachment);
      this.apply(outcome.effects, null);
    }
    closeSocket(ws, code === 1005 || code === 1006 ? 1000 : code, "bye");
  }

  private directory() {
    return this.env.INVITE_DIRECTORY.getByName(INVITE_DIRECTORY_NAME);
  }

  private online(exclude?: WebSocket) {
    return onlineMembers(this.ctx, exclude);
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
          : socketsOf(this.ctx, effect.to.memberId);
      for (const ws of targets) {
        if (effect.kind === "send") this.sendTo(ws, effect.message);
        else closeSocket(ws, effect.code, effect.reason);
      }
    }
  }

  private async saveTransition(
    next: RoomState,
    { departed, accepted }: { departed?: string; accepted?: WebSocket } = {},
  ) {
    const before = this.room;
    const retired = await this.ctx.storage.transaction(async (txn) => {
      const targets = before
        ? await retireRoomResources(txn, before, next, departed)
        : [];
      await txn.put(STATE_KEY, next);
      if (targets.length) await this.armCleanup(txn, next);
      else
        await this.writeAlarm(
          txn,
          (await txn.get<Retry>(RETRY_KEY)) ?? null,
          next,
          authTimeouts(this.ctx, { accepted }).alarm,
        );
      return targets;
    });
    this.room = next;
    this.closeRetired(retired);
  }

  private async scheduleAlarm(authAlarm: number) {
    await this.ctx.storage.transaction(async (txn) => {
      await this.writeAlarm(
        txn,
        (await txn.get<Retry>(RETRY_KEY)) ?? null,
        this.room,
        authAlarm,
      );
    });
  }

  private async writeAlarm(
    txn: DurableObjectTransaction,
    retry: Retry | null,
    room = this.room,
    authAlarm = authTimeouts(this.ctx).alarm,
  ) {
    let next = Infinity;
    if (room) {
      next = Math.min(closeAt(room, this.config), authAlarm);
    }
    if (retry?.at != null) next = Math.min(next, retry.at);
    if (next === Infinity) await txn.deleteAlarm();
    else await txn.setAlarm(next);
  }
}
