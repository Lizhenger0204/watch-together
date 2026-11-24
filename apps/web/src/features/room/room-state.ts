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
  /** 只有房主會收到（收看者回報的連線品質）。只保留在線成員的。 */
  memberStatus: Record<string, MemberStatus>;
  closedBy: ServerMessageOf<"room:closed">["reason"] | null;
  lastError: string | null;
};

export type RoomEvent =
  | { kind: "connection"; state: ConnectionState }
  | { kind: "message"; message: ServerMessage }
  /** 重新產生邀請碼的 REST 回應（WebSocket 斷線時也能更新畫面）。 */
  | { kind: "invite-code"; inviteCode: string }
  | { kind: "clear-error" };

export const initialRoomView: RoomView = {
  connection: { status: "connecting" },
  room: null,
  members: [],
  stream: { live: false, title: null, startedAt: null },
  you: null,
  session: 0,
  memberStatus: {},
  closedBy: null,
  lastError: null,
};

export function roomReducer(state: RoomView, event: RoomEvent): RoomView {
  if (event.kind === "connection") return { ...state, connection: event.state };
  if (event.kind === "clear-error") return { ...state, lastError: null };
  if (event.kind === "invite-code") {
    return state.room
      ? { ...state, room: { ...state.room, inviteCode: event.inviteCode } }
      : state;
  }

  const message = event.message;
  switch (message.type) {
    case "room:snapshot":
      return {
        ...state,
        room: message.room,
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
      return { ...state, room: message.room };
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
  if (view.closedBy || reason === "room_closed") {
    return {
      notice: "房間已關閉（閒置太久或已超過 24 小時）。請房主重新建立房間。",
    };
  }
  if (reason === "unauthorized") {
    return { notice: "你在這個房間的身份已失效，請重新用邀請碼加入。" };
  }
  return null;
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
