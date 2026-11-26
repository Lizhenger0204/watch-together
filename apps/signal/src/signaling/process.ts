import type { ClientMessage, ErrorCode, ServerMessage } from "@project/shared";
import type { RoomConfig } from "../config";
import {
  OFFLINE_STREAM,
  findMember,
  findMemberByTokenHash,
  hostDisconnectedSince,
  hostOf,
  invalidateRelayRequests,
  removeMember,
  toMembers,
  toRoomInfo,
  touchMember,
  type Online,
  type RoomState,
} from "../room/room";
import type { ChatRateLimiter } from "./chat-rate-limit";

// 信令與房間事件的純邏輯：輸入目前狀態與事件，輸出新狀態與要執行的副作用。
// runtime（Durable Object 或之後的 Node 版本）只負責執行副作用。

/** `conn`：觸發這次事件的連線（尚未驗證時只能用它）。 */
export type Target = { memberId: string } | { conn: true };

export type Effect =
  | { kind: "send"; to: Target; message: ServerMessage }
  | { kind: "close"; to: Target; code: number; reason: string };

export type Outcome = { state: RoomState; effects: Effect[] };

/** WebSocket 關閉碼（4000–4999 為應用程式自訂）。 */
export const CLOSE = {
  REPLACED: 4000,
  ROOM_CLOSED: 4001,
  KICKED: 4003,
  BAD_REQUEST: 4400,
  UNAUTHORIZED: 4401,
  AUTH_TIMEOUT: 4408,
  HEARTBEAT_TIMEOUT: 4410,
} as const;

const CONN: Target = { conn: true };
const to = (memberId: string): Target => ({ memberId });
const send = (target: Target, message: ServerMessage): Effect => ({
  kind: "send",
  to: target,
  message,
});

function membersTo(state: RoomState, online: Online, except?: string) {
  const members = toMembers(state, online);
  return [...online]
    .filter((id) => id !== except)
    .map((id) => send(to(id), { type: "room:members", members }));
}

function roomUpdatedTo(state: RoomState, online: Online) {
  return [...online].flatMap((id) => {
    const member = findMember(state, id);
    return member
      ? [
          send(to(id), {
            type: "room:updated",
            room: toRoomInfo(state, member.role),
          }),
        ]
      : [];
  });
}

function streamTo(state: RoomState, online: Online, except?: string) {
  return [...online]
    .filter((id) => id !== except)
    .map((id) => send(to(id), { type: "stream:status", ...state.stream }));
}

/** P2P 模式、房主在線且正在直播時，請房主對這些收看者發起連線。 */
function peerRequests(state: RoomState, online: Online, memberIds: string[]) {
  const host = hostOf(state);
  if (
    !host ||
    state.mode !== "p2p" ||
    !state.stream.live ||
    !online.has(host.memberId)
  ) {
    return [];
  }
  return memberIds
    .filter((id) => id !== host.memberId && online.has(id))
    .map((memberId) =>
      send(to(host.memberId), { type: "peer:request", memberId }),
    );
}

function viewers(state: RoomState, online: Online) {
  return state.members
    .filter((m) => m.role === "member" && online.has(m.memberId))
    .map((m) => m.memberId);
}

function fail(
  target: Target,
  reqId: string | undefined,
  code: ErrorCode,
  message: string,
): Effect {
  return reqId
    ? send(target, { type: "ack", reqId, ok: false, code })
    : send(target, { type: "error", code, message });
}

function ok(target: Target, reqId: string | undefined): Effect[] {
  return reqId ? [send(target, { type: "ack", reqId, ok: true })] : [];
}

// ── 驗證 ───────────────────────────────────────────────────

export type AuthOutcome =
  | { accepted: false; effects: Effect[] }
  | { accepted: true; memberId: string; state: RoomState; effects: Effect[] };

/**
 * 處理 auth 訊息。`onlineBefore` 是驗證前已在線的成員。
 * 接受時，runtime 要先把同一成員的舊連線以 REPLACED 關閉、把這條連線標記為該成員，再執行 effects。
 */
export function onAuth(
  state: RoomState,
  input: { tokenHash: string; protocolVersion: number; reqId?: string },
  expectedVersion: number,
  onlineBefore: Online,
  now: number,
): AuthOutcome {
  if (input.protocolVersion !== expectedVersion) {
    return {
      accepted: false,
      effects: [
        send(CONN, {
          type: "error",
          code: "BAD_REQUEST",
          message: "協定版本不符，請重新整理頁面",
        }),
        {
          kind: "close",
          to: CONN,
          code: CLOSE.BAD_REQUEST,
          reason: "protocol_version",
        },
      ],
    };
  }
  const member = findMemberByTokenHash(state, input.tokenHash);
  if (!member) {
    return {
      accepted: false,
      effects: [
        send(CONN, {
          type: "error",
          code: "UNAUTHORIZED",
          message: "身份驗證失敗",
        }),
        {
          kind: "close",
          to: CONN,
          code: CLOSE.UNAUTHORIZED,
          reason: "unauthorized",
        },
      ],
    };
  }

  const { memberId } = member;
  const online = new Set(onlineBefore).add(memberId);
  let next: RoomState = {
    ...touchMember(state, memberId, now),
    idleSince: null,
    ...(member.role === "host" ? { hostDisconnectedAt: null } : {}),
  };
  // 房主每次驗證成功都是新的直播工作階段（重新整理、換分頁取代 4000、斷線重連）：
  // 一律改為未開播。房主端有片源時再送 stream:status { live: true, title }，
  // 伺服器才對所有在線收看者送 peer:request（protocol.md「房主重新連線」）。
  const hostRestarted = member.role === "host" && state.stream.live;
  if (hostRestarted) next = { ...next, stream: OFFLINE_STREAM };

  return {
    accepted: true,
    memberId,
    state: next,
    effects: [
      // 房主重新驗證：先讓收看者停掉舊的連線，再回房主 snapshot（protocol.md「房主重新連線」）。
      ...(hostRestarted ? streamTo(next, online, memberId) : []),
      send(to(memberId), {
        type: "room:snapshot",
        room: toRoomInfo(next, member.role),
        members: toMembers(next, online),
        stream: next.stream,
        you: { memberId, role: member.role },
      }),
      ...ok(to(memberId), input.reqId),
      ...membersTo(next, online, memberId),
      ...(member.role === "member"
        ? peerRequests(next, online, [memberId])
        : []),
    ],
  };
}

// ── 已驗證連線的訊息 ───────────────────────────────────────

export type MessageDeps = {
  generateId?: () => string;
  chatLimiter?: ChatRateLimiter;
};

export function onMessage(
  state: RoomState,
  senderId: string,
  message: Exclude<ClientMessage, { type: "auth" }>,
  online: Online,
  now: number,
  deps?: MessageDeps,
): Outcome {
  const sender = findMember(state, senderId);
  const self = to(senderId);
  if (!sender) {
    return {
      state,
      effects: [
        {
          kind: "close",
          to: self,
          code: CLOSE.UNAUTHORIZED,
          reason: "unknown_member",
        },
      ],
    };
  }
  const isHost = sender.role === "host";
  const reqId = "reqId" in message ? message.reqId : undefined;
  const forbidden = (): Outcome => ({
    state,
    effects: [fail(self, reqId, "FORBIDDEN", "沒有權限執行這個操作")],
  });

  switch (message.type) {
    case "ping":
      return { state, effects: [send(self, { type: "pong" })] };

    case "room:update": {
      if (!isHost) return forbidden();
      const next: RoomState = {
        ...state,
        locked: message.locked ?? state.locked,
        mode: message.mode ?? state.mode,
        quality: message.quality ?? state.quality,
      };
      const switchedToP2p = state.mode !== "p2p" && next.mode === "p2p";
      return {
        state: switchedToP2p ? invalidateRelayRequests(next) : next,
        effects: [
          ...ok(self, reqId),
          ...roomUpdatedTo(next, online),
          ...(switchedToP2p
            ? peerRequests(next, online, viewers(next, online))
            : []),
        ],
      };
    }

    case "room:kick": {
      if (!isHost) return forbidden();
      const target = findMember(state, message.memberId);
      if (!target || target.role === "host") {
        return {
          state,
          effects: [fail(self, reqId, "BAD_REQUEST", "無法踢出這位成員")],
        };
      }
      const next = removeMember(state, target.memberId);
      deps?.chatLimiter?.forget(target.memberId);
      const onlineAfter = new Set(online);
      onlineAfter.delete(target.memberId);
      return {
        state: next,
        effects: [
          ...ok(self, reqId),
          send(to(target.memberId), { type: "room:closed", reason: "kicked" }),
          {
            kind: "close",
            to: to(target.memberId),
            code: CLOSE.KICKED,
            reason: "kicked",
          },
          ...membersTo(next, onlineAfter),
        ],
      };
    }

    case "stream:status": {
      if (!isHost) return forbidden();
      const wasLive = state.stream.live;
      const next: RoomState = {
        ...state,
        stream: message.live
          ? {
              live: true,
              title: message.title,
              startedAt: wasLive ? state.stream.startedAt : now,
            }
          : OFFLINE_STREAM,
      };
      const wentLive = !wasLive && message.live;
      return {
        state: next,
        effects: [
          ...ok(self, reqId),
          ...streamTo(next, online),
          ...(wentLive
            ? peerRequests(next, online, viewers(next, online))
            : []),
        ],
      };
    }

    case "signal": {
      const target = findMember(state, message.to);
      // 收看者只能送給房主；房主可以送給任何收看者。
      const allowed =
        target !== undefined &&
        target.memberId !== senderId &&
        (isHost || target.role === "host");
      if (!allowed) {
        return {
          state,
          effects: [
            fail(self, undefined, "FORBIDDEN", "不能傳送信令給這位成員"),
          ],
        };
      }
      if (!online.has(target.memberId)) {
        return {
          state,
          effects: [fail(self, undefined, "BAD_REQUEST", "對方目前不在線上")],
        };
      }
      return {
        state,
        effects: [
          send(to(target.memberId), {
            type: "signal",
            from: senderId,
            data: message.data,
          }),
        ],
      };
    }

    case "member:status": {
      if (isHost) return forbidden();
      const host = hostOf(state);
      if (!host || !online.has(host.memberId)) return { state, effects: [] };
      const { state: memberState, bitrateKbps, rttMs, packetLoss } = message;
      const status = { state: memberState, bitrateKbps, rttMs, packetLoss };
      return {
        state,
        effects: [
          send(to(host.memberId), {
            type: "member:status",
            memberId: senderId,
            status,
          }),
        ],
      };
    }

    case "chat:send": {
      if (deps?.chatLimiter && !deps.chatLimiter.allow(senderId, now)) {
        return {
          state,
          effects: [
            fail(self, reqId, "RATE_LIMITED", "發言太頻繁了，請稍後再試"),
          ],
        };
      }
      const chatMessage: ServerMessage = {
        type: "chat:message",
        id: deps?.generateId?.() ?? crypto.randomUUID(),
        memberId: sender.memberId,
        nickname: sender.nickname,
        role: sender.role,
        text: message.text,
        sentAt: now,
      };
      return {
        state,
        effects: [
          ...ok(self, reqId),
          ...[...online].map((id) => send(to(id), chatMessage)),
        ],
      };
    }
  }
}

// ── 斷線與關房 ─────────────────────────────────────────────

/** `onlineAfter`：這條連線關閉後仍在線的成員。`offlineAt` 為離線起算時間（心跳逾時用最後活動時間）。 */
export function onDisconnect(
  state: RoomState,
  memberId: string,
  onlineAfter: Online,
  now: number,
  offlineAt = now,
): Outcome {
  const member = findMember(state, memberId);
  if (!member || onlineAfter.has(memberId)) return { state, effects: [] };

  let next = touchMember(state, memberId, offlineAt);
  if (state.mode === "relay") next = invalidateRelayRequests(next, memberId);
  if (onlineAfter.size === 0) next = { ...next, idleSince: offlineAt };
  if (member.role === "host") {
    next = { ...next, hostDisconnectedAt: offlineAt };
  }

  const effects = membersTo(next, onlineAfter);
  // 房主斷線 = 直播中斷；房主重新連線後會再送 stream:status。
  if (member.role === "host" && state.stream.live) {
    next = { ...next, stream: OFFLINE_STREAM };
    effects.push(...streamTo(next, onlineAfter));
  }
  return { state: next, effects };
}

/** 房主離線滿期限後移出房間，有收看者時保留房間並廣播更新後成員名單。 */
export function onHostOfflineTimeout(
  state: RoomState,
  online: Online,
  now: number,
  config: Pick<RoomConfig, "hostOfflineTtlMs">,
  deps?: Pick<MessageDeps, "chatLimiter">,
): { removed: boolean; state: RoomState; effects: Effect[] } {
  const host = hostOf(state);
  if (!host || online.has(host.memberId)) {
    return { removed: false, state, effects: [] };
  }
  const since = hostDisconnectedSince(state, online);
  if (since === null || now < since + config.hostOfflineTtlMs) {
    return { removed: false, state, effects: [] };
  }
  let next = removeMember(state, host.memberId);
  deps?.chatLimiter?.forget(host.memberId);
  if (online.size === 0 && next.idleSince === null) {
    next = { ...next, idleSince: since };
  }
  const effects = membersTo(next, online);
  if (state.stream.live) {
    next = { ...next, stream: OFFLINE_STREAM };
    effects.push(...streamTo(next, online));
  }
  return { removed: true, state: next, effects };
}

export function closeRoomEffects(
  online: Online,
  reason: "expired" | "host_closed",
): Effect[] {
  return [...online].flatMap((id): Effect[] => [
    send(to(id), { type: "room:closed", reason }),
    { kind: "close", to: to(id), code: CLOSE.ROOM_CLOSED, reason },
  ]);
}
