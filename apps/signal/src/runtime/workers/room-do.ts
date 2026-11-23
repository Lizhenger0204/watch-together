import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type Role,
} from "@project/shared";
import { DurableObject } from "cloudflare:workers";
import { readRoomConfig, type RoomConfig } from "../../config";
import { errorBody, type Result } from "../../errors";
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

/**
 * 每個房間一個實例。使用 WebSocket Hibernation API：
 * DO 可能隨時休眠，記憶體會清空，所以狀態一律寫進 storage，計時一律用 alarm。
 */
export class RoomDO extends DurableObject<Env> {
  private room: RoomState | null = null;
  private readonly config: RoomConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readRoomConfig(env as unknown as Record<string, unknown>);
    void ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
    });
  }

  // ── RPC（由 Worker 呼叫）──────────────────────────────────

  async init(input: {
    roomId: string;
    inviteCode: string;
    nickname: string;
  }): Promise<{ hostToken: string; memberId: string }> {
    if (this.room) throw new Error("房間已初始化");
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
    if (!this.room) return { ok: false, code: "ROOM_NOT_FOUND" };
    if (findMember(this.room, hostMemberId)?.role !== "host") {
      return { ok: false, code: "FORBIDDEN" };
    }
    const directory = this.env.INVITE_DIRECTORY.getByName(
      INVITE_DIRECTORY_NAME,
    );
    const inviteCode = await directory.replace(
      this.room.inviteCode,
      this.room.roomId,
    );
    if (!this.room) return { ok: false, code: "ROOM_NOT_FOUND" };
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
      ws.close(CLOSE.BAD_REQUEST, "binary_not_supported");
      return;
    }
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      this.sendTo(ws, {
        type: "error",
        code: "BAD_REQUEST",
        message: parsed.error,
      });
      return;
    }
    const message = parsed.message;
    const now = Date.now();

    if (attachment.memberId === null) {
      if (message.type !== "auth") {
        ws.close(CLOSE.BAD_REQUEST, "auth_required");
        return;
      }
      if (now > attachment.authDeadline) {
        ws.close(CLOSE.AUTH_TIMEOUT, "auth_timeout");
        return;
      }
      const tokenHash = await hashToken(message.token);
      if (!this.room) return;
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
          other.close(CLOSE.REPLACED, "replaced");
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
      now,
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

  override async alarm() {
    const now = Date.now();
    if (this.room && now >= closeAt(this.room, this.config)) {
      await this.closeRoom("expired");
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(ws);
      if (attachment?.memberId === null && now > attachment.authDeadline) {
        ws.close(CLOSE.AUTH_TIMEOUT, "auth_timeout");
      }
    }
    await this.scheduleAlarm();
  }

  private async closeRoom(reason: "expired" | "host_closed") {
    const room = this.room;
    if (!room) return;
    this.apply(closeRoomEffects(this.online(), reason), null);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CLOSE.ROOM_CLOSED, reason);
      } catch {
        // 已經關閉
      }
    }
    this.room = null;
    await this.env.INVITE_DIRECTORY.getByName(INVITE_DIRECTORY_NAME).release(
      room.inviteCode,
      room.roomId,
    );
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    console.log(JSON.stringify({ event: "room.closed", reason }));
  }

  // ── 工具 ───────────────────────────────────────────────────

  private async handleSocketGone(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // 已經關閉
    }
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
        else {
          try {
            ws.close(effect.code, effect.reason);
          } catch {
            // 已經關閉
          }
        }
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
