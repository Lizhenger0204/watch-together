import { createRoomState, type RoomState } from "../src/room/room";
import type { Effect } from "../src/signaling/process";

export const T0 = 1_000_000;

export const LIVE = { live: true, title: "電影", startedAt: T0 };

export function roomWith(overrides: Partial<RoomState> = {}): RoomState {
  const base = createRoomState({
    roomId: "r1",
    inviteCode: "ABCDEFGH",
    host: { memberId: "host", nickname: "房主", tokenHash: "h-host" },
    now: T0,
  });
  return {
    ...base,
    members: [
      ...base.members,
      {
        memberId: "a",
        nickname: "A",
        role: "member",
        tokenHash: "h-a",
        joinedAt: T0,
        lastSeenAt: T0,
      },
      {
        memberId: "b",
        nickname: "B",
        role: "member",
        tokenHash: "h-b",
        joinedAt: T0,
        lastSeenAt: T0,
      },
    ],
    ...overrides,
  };
}

/** 取出送給某成員的訊息。 */
export const sentTo = (effects: Effect[], memberId: string) =>
  effects
    .filter(
      (e) =>
        e.kind === "send" && "memberId" in e.to && e.to.memberId === memberId,
    )
    .map((e) => (e.kind === "send" ? e.message : null));

/** 取出送給某成員的訊息 type。 */
export const typesTo = (effects: Effect[], memberId: string) =>
  sentTo(effects, memberId).map((m) => m?.type);
