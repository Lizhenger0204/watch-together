import {
  DEFAULT_QUALITY,
  parseStoredQuality,
  type Member,
  type Mode,
  type Quality,
  type Role,
  type RoomInfo,
  type StreamInfo,
} from "@project/shared";
import type { RoomConfig } from "../config";
import { timingSafeEqual } from "./crypto";
import type { JoinKeyRecord } from "./join-key";

// 房間狀態的純邏輯。不依賴 Workers、Hono 或 Durable Objects。
// 「誰在線上」不存在狀態裡，由 runtime 依實際連線提供（online 參數）。

export type MemberRecord = {
  memberId: string;
  nickname: string;
  role: Role;
  tokenHash: string;
  joinedAt: number;
  lastSeenAt: number;
  /** 舊房間未儲存此欄位，視為第 0 代。 */
  relayGeneration?: number;
};

export type RoomState = {
  roomId: string;
  createdAt: number;
  locked: boolean;
  mode: Mode;
  /** T-126 以前的房間存的是預設名稱字串，送出前一律經過 parseStoredQuality。 */
  quality: Quality;
  inviteCode: string;
  /** 換碼版本（初始 0，每次成功換碼遞增）。舊房間沒有此欄位，視為 0。 */
  inviteCodeVersion?: number;
  members: MemberRecord[];
  stream: StreamInfo;
  /** 最後一人離線的時間；有人在線時為 null。 */
  idleSince: number | null;
  /** 房主離線的時間；房主在線或已移出房間時為 null。舊房間沒有此欄位。 */
  hostDisconnectedAt?: number | null;
  /** 加入冪等鍵的紀錄（join-key.ts）。舊房間沒有此欄位。 */
  joinKeys?: JoinKeyRecord[];
};

export type Online = ReadonlySet<string>;

export const OFFLINE_STREAM: StreamInfo = {
  live: false,
  title: null,
  startedAt: null,
};

export function createRoomState(input: {
  roomId: string;
  inviteCode: string;
  host: { memberId: string; nickname: string; tokenHash: string };
  now: number;
}): RoomState {
  return {
    roomId: input.roomId,
    createdAt: input.now,
    locked: false,
    mode: "p2p",
    quality: DEFAULT_QUALITY,
    inviteCode: input.inviteCode,
    inviteCodeVersion: 0,
    members: [
      {
        ...input.host,
        role: "host",
        joinedAt: input.now,
        lastSeenAt: input.now,
      },
    ],
    stream: OFFLINE_STREAM,
    // 房主建房後還沒連線，也算閒置與離線；一直沒連線就會在期限後移除並關房。
    idleSince: input.now,
    hostDisconnectedAt: input.now,
  };
}

export function findMember(state: RoomState, memberId: string) {
  return state.members.find((m) => m.memberId === memberId);
}

/** 逐一比較所有成員、不提早結束，讓回應時間與是否命中、命中第幾位無關。 */
export function findMemberByTokenHash(state: RoomState, tokenHash: string) {
  let found: MemberRecord | undefined;
  for (const member of state.members) {
    if (timingSafeEqual(member.tokenHash, tokenHash)) found = member;
  }
  return found;
}

export function hostOf(state: RoomState) {
  return state.members.find((m) => m.role === "host");
}

/** 房主目前離線的起算時間；房主在線或已不在房內時為 null。 */
export function hostDisconnectedSince(
  state: RoomState,
  online: Online,
): number | null {
  const host = hostOf(state);
  if (!host || online.has(host.memberId)) return null;
  return state.hostDisconnectedAt !== undefined
    ? state.hostDisconnectedAt
    : host.lastSeenAt;
}

/** 房主因離線逾時應被移出房間的時間點；不適用時回 null。 */
export function hostRemoveAt(
  state: RoomState,
  online: Online,
  config: Pick<RoomConfig, "hostOfflineTtlMs">,
): number | null {
  const since = hostDisconnectedSince(state, online);
  return since === null ? null : since + config.hostOfflineTtlMs;
}

/** 移除離線太久的收看者，騰出名額。房主永遠保留。 */
export function pruneStaleMembers(
  state: RoomState,
  online: Online,
  now: number,
  config: Pick<RoomConfig, "staleMemberMs">,
): RoomState {
  const members = state.members.filter(
    (m) =>
      m.role === "host" ||
      online.has(m.memberId) ||
      now - m.lastSeenAt < config.staleMemberMs,
  );
  return members.length === state.members.length
    ? state
    : { ...state, members };
}

export type JoinOutcome =
  | { ok: true; state: RoomState }
  | { ok: false; code: "ROOM_NOT_FOUND" | "ROOM_FULL" };

export function addMember(
  state: RoomState,
  input: {
    inviteCode: string;
    excluded?: boolean;
    member: { memberId: string; nickname: string; tokenHash: string };
  },
  online: Online,
  now: number,
  config: Pick<RoomConfig, "maxMembers" | "staleMemberMs">,
): JoinOutcome {
  // 邀請碼不符（已重新產生）、鎖房或房主已離開一律回 ROOM_NOT_FOUND，不洩漏房間存在。
  if (input.inviteCode !== state.inviteCode || state.locked || !hostOf(state)) {
    return { ok: false, code: "ROOM_NOT_FOUND" };
  }
  const pruned = pruneStaleMembers(state, online, now, config);
  if (pruned.members.length >= config.maxMembers) {
    return { ok: false, code: "ROOM_FULL" };
  }
  if (input.excluded) return { ok: false, code: "ROOM_NOT_FOUND" };
  return {
    ok: true,
    state: {
      ...pruned,
      members: [
        ...pruned.members,
        { ...input.member, role: "member", joinedAt: now, lastSeenAt: now },
      ],
    },
  };
}

export function removeMember(state: RoomState, memberId: string): RoomState {
  const target = findMember(state, memberId);
  const joinKeys = state.joinKeys?.filter(
    (record) => record.memberId !== memberId,
  );
  return {
    ...state,
    members: state.members.filter((m) => m.memberId !== memberId),
    ...(joinKeys !== undefined ? { joinKeys } : {}),
    ...(target?.role === "host" ? { hostDisconnectedAt: null } : {}),
  };
}

export function touchMember(
  state: RoomState,
  memberId: string,
  now: number,
): RoomState {
  return {
    ...state,
    members: state.members.map((m) =>
      m.memberId === memberId ? { ...m, lastSeenAt: now } : m,
    ),
  };
}

/** 切離轉發時使全房在途請求失效；單人離線只影響自己的請求。 */
export function invalidateRelayRequests(
  state: RoomState,
  memberId?: string,
): RoomState {
  return {
    ...state,
    members: state.members.map((member) =>
      memberId === undefined || member.memberId === memberId
        ? { ...member, relayGeneration: (member.relayGeneration ?? 0) + 1 }
        : member,
    ),
  };
}

export function toRoomInfo(state: RoomState, role: Role): RoomInfo {
  const info: RoomInfo = {
    roomId: state.roomId,
    locked: state.locked,
    mode: state.mode,
    quality: parseStoredQuality(state.quality),
    createdAt: state.createdAt,
  };
  return role === "host"
    ? {
        ...info,
        inviteCode: state.inviteCode,
        inviteCodeVersion: state.inviteCodeVersion ?? 0,
      }
    : info;
}

export function toMembers(state: RoomState, online: Online): Member[] {
  return state.members.map((m) => ({
    memberId: m.memberId,
    nickname: m.nickname,
    role: m.role,
    online: online.has(m.memberId),
  }));
}

/** 房間應該關閉的時間點。無人時立刻到期。 */
export function closeAt(
  state: RoomState,
  config: Pick<RoomConfig, "idleTtlMs" | "maxAgeMs">,
) {
  if (state.members.length === 0) return 0;
  const maxAge = state.createdAt + config.maxAgeMs;
  return state.idleSince === null
    ? maxAge
    : Math.min(maxAge, state.idleSince + config.idleTtlMs);
}
