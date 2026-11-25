import {
  type ClientMessageOf,
  type Member,
  type MemberStatus,
  type Mode,
  type Quality,
  type RoomInfo,
  type ServerMessage,
  type ServerMessageOf,
  type StreamInfo,
} from "@project/shared";
import type { ConnectionState } from "../../lib/signal";
import { roomToken } from "../../lib/storage";
import {
  estimateTotalUploadBitrate,
  shouldWarnTotalUpload,
} from "../transport";

/** 房主可以改的房間設定（room:update 去掉 type、reqId）。 */
export type RoomUpdate = Omit<ClientMessageOf<"room:update">, "type" | "reqId">;

export type RoomView = {
  connection: ConnectionState;
  room: RoomInfo | null;
  members: Member[];
  stream: StreamInfo;
  you: ServerMessageOf<"room:snapshot">["you"] | null;
  /** 第幾次收到 room:snapshot（每次重新驗證加一）。 */
  session: number;
  /** 最後一次送出的重產邀請碼請求，與送出當時畫面上的邀請碼。 */
  inviteRequest: { id: number; from: string | null } | null;
  /**
   * 重產成功後已失效的舊碼。重產前送出、重產後才到的廣播或 snapshot 仍帶著它，
   * 不可把畫面蓋回去（伺服器提交新碼後不會再送出舊碼）。
   */
  retiredInviteCode: string | null;
  /** 只有房主會收到（收看者回報的連線品質）。只保留在線成員的。 */
  memberStatus: Record<string, MemberStatus>;
  closedBy: ServerMessageOf<"room:closed">["reason"] | null;
  lastError: string | null;
};

export type RoomEvent =
  | { kind: "connection"; state: ConnectionState }
  | { kind: "message"; message: ServerMessage }
  /** 送出重新產生邀請碼的 REST 請求（記下當時畫面上的邀請碼）。 */
  | { kind: "invite-requested"; id: number }
  /**
   * 重新產生邀請碼的 REST 回應（WebSocket 斷線時也能更新畫面）。
   * 只有畫面上的碼已被伺服器推送更新，或之後又送出了重產請求時才忽略；
   * 期間收到仍帶舊碼的廣播（例如鎖房、畫質）不影響。
   */
  | { kind: "invite-code"; id: number; inviteCode: string }
  | { kind: "clear-error" };

export const initialRoomView: RoomView = {
  connection: { status: "connecting" },
  room: null,
  members: [],
  stream: { live: false, title: null, startedAt: null },
  you: null,
  session: 0,
  inviteRequest: null,
  retiredInviteCode: null,
  memberStatus: {},
  closedBy: null,
  lastError: null,
};

/** 帶著已失效舊碼的晚到房間狀態：保留畫面上的有效碼，其餘欄位照常更新。 */
function keepCurrentCode(state: RoomView, room: RoomInfo): RoomInfo {
  const current = state.room?.inviteCode;
  return current &&
    room.inviteCode !== undefined &&
    room.inviteCode === state.retiredInviteCode
    ? { ...room, inviteCode: current }
    : room;
}

export function roomReducer(state: RoomView, event: RoomEvent): RoomView {
  if (event.kind === "connection") return { ...state, connection: event.state };
  if (event.kind === "clear-error") return { ...state, lastError: null };
  if (event.kind === "invite-requested") {
    return {
      ...state,
      inviteRequest: { id: event.id, from: state.room?.inviteCode ?? null },
    };
  }
  if (event.kind === "invite-code") {
    const request = state.inviteRequest;
    if (request?.id !== event.id) return state;
    // 畫面上的碼已被伺服器推送換掉：那份就是這次（或之後又換過）的碼，不要蓋回去。
    const room = state.room?.inviteCode === request.from ? state.room : null;
    return {
      ...state,
      inviteRequest: null,
      retiredInviteCode: request.from,
      room: room ? { ...room, inviteCode: event.inviteCode } : state.room,
    };
  }

  const message = event.message;
  switch (message.type) {
    case "room:snapshot":
      return {
        ...state,
        room: keepCurrentCode(state, message.room),
        members: message.members,
        stream: message.stream,
        you: message.you,
        session: state.session + 1,
        // 上一條連線期間的統計已經過時，等收看者重新回報。
        memberStatus: {},
      };
    case "room:members": {
      const ids = new Set(
        message.members.filter((m) => m.online).map((m) => m.memberId),
      );
      const memberStatus = Object.fromEntries(
        Object.entries(state.memberStatus).filter(([id]) => ids.has(id)),
      );
      return { ...state, members: message.members, memberStatus };
    }
    case "room:updated":
      return { ...state, room: keepCurrentCode(state, message.room) };
    case "stream:status": {
      const { live, title, startedAt } = message;
      return { ...state, stream: { live, title, startedAt } };
    }
    case "member:status":
      return {
        ...state,
        memberStatus: {
          ...state.memberStatus,
          [message.memberId]: message.status,
        },
      };
    case "room:closed":
      return { ...state, closedBy: message.reason };
    case "error":
      return { ...state, lastError: message.message };
    default:
      return state;
  }
}

export type RoomExit = { notice: string };

/**
 * 需要清掉 token、離開房間回首頁的情況（protocol.md「關閉碼」：4001／4003／4401）。
 * 4000（另一分頁接手）與驗證後的 4400 留在房間頁顯示說明，不清 token。
 */
export function roomExit(view: RoomView): RoomExit | null {
  const c = view.connection;
  const reason = c.status === "closed" ? c.reason : null;
  if (view.closedBy === "kicked" || reason === "kicked") {
    return { notice: "你已被房主請出房間。如果是誤會，請向房主要新的邀請碼。" };
  }
  if (view.closedBy === "host_closed") {
    return { notice: "房主已關閉房間。" };
  }
  if (view.closedBy === "expired") {
    return {
      notice: "房間已到期（閒置太久或已超過 24 小時）。請房主重新建立房間。",
    };
  }
  if (reason === "room_closed") {
    // 只有 4001、沒收到 room:closed（例如連到已關閉的房間）：不知道是哪一種。
    return {
      notice:
        "房間已關閉（房主關閉，或閒置太久、已超過 24 小時）。請向房主確認。",
    };
  }
  if (reason === "unauthorized") {
    return { notice: "你在這個房間的身份已失效，請重新用邀請碼加入。" };
  }
  return null;
}

/**
 * 離開房間（roomExit）時清掉本機身份。只清本分頁連線用的那份憑證：共用儲存裡可能已是
 * 另一分頁剛換到的新憑證（例如舊分頁收到 4401 時）。token 格式損壞（null）就整份清掉。
 */
export function forgetRoomIdentity(roomId: string, token: string | null) {
  if (token) roomToken.clearIfCurrent(roomId, token);
  else roomToken.clear(roomId);
}

/**
 * P2P 模式下房主要上傳的總量（bps）與是否該提醒（streaming.md §2「P2P 總頻寬保護」）。
 * 轉發只上傳一份、沒有收看者時不需要提示，回 null。
 */
export function uploadHint(mode: Mode, quality: Quality, viewers: number) {
  if (mode !== "p2p" || viewers <= 0) return null;
  return {
    total: estimateTotalUploadBitrate(quality, viewers),
    warn: shouldWarnTotalUpload(quality, viewers),
  };
}

export const formatMbps = (bps: number) =>
  `${(bps / 1_000_000).toFixed(bps % 1_000_000 === 0 ? 0 : 1)} Mbps`;
