import {
  P2P_TOTAL_BITRATE_WARNING,
  QUALITY_PRESETS,
  type Member,
  type MemberStatus,
  type Quality,
  type Role,
  type RoomInfo,
  type ServerMessage,
  type StreamInfo,
} from "@project/shared";
import type { ConnectionState } from "../../lib/signal";

export type RoomView = {
  connection: ConnectionState;
  room: RoomInfo | null;
  members: Member[];
  stream: StreamInfo;
  you: { memberId: string; role: Role } | null;
  /** 只有房主會收到（收看者回報的連線品質）。 */
  memberStatus: Record<string, MemberStatus>;
  closedBy: "expired" | "kicked" | "host_closed" | null;
  lastError: string | null;
};

export type RoomEvent =
  | { kind: "connection"; state: ConnectionState }
  | { kind: "message"; message: ServerMessage }
  | { kind: "clear-error" };

export const initialRoomView: RoomView = {
  connection: { status: "connecting" },
  room: null,
  members: [],
  stream: { live: false, title: null, startedAt: null },
  you: null,
  memberStatus: {},
  closedBy: null,
  lastError: null,
};

export function roomReducer(state: RoomView, event: RoomEvent): RoomView {
  if (event.kind === "connection") return { ...state, connection: event.state };
  if (event.kind === "clear-error") return { ...state, lastError: null };

  const message = event.message;
  switch (message.type) {
    case "room:snapshot":
      return {
        ...state,
        room: message.room,
        members: message.members,
        stream: message.stream,
        you: message.you,
      };
    case "room:members": {
      const ids = new Set(message.members.map((m) => m.memberId));
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

/** P2P 模式下房主要上傳的總量（bps）與是否該提醒（streaming.md §2）。 */
export function estimateP2pUpload(quality: Quality, viewers: number) {
  const total = QUALITY_PRESETS[quality].maxBitrate * viewers;
  return { total, warn: total > P2P_TOTAL_BITRATE_WARNING };
}

export const formatMbps = (bps: number) =>
  `${(bps / 1_000_000).toFixed(bps % 1_000_000 === 0 ? 0 : 1)} Mbps`;
