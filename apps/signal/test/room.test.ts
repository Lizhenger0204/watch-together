import { describe, expect, test } from "vitest";
import {
  addMember,
  closeAt,
  createRoomState,
  findMemberByTokenHash,
  hostDisconnectedSince,
  hostOf,
  hostRemoveAt,
  pruneStaleMembers,
  removeMember,
  toMembers,
  toRoomInfo,
  type MemberRecord,
} from "../src/room/room";
import {
  generateInviteCode,
  isRoomId,
  timingSafeEqual,
} from "../src/room/crypto";
import { DEFAULT_QUALITY, normalizeInviteCode } from "@project/shared";

const config = {
  maxMembers: 3,
  idleTtlMs: 100_000,
  hostOfflineTtlMs: 100_000,
  maxAgeMs: 24 * 60 * 60_000,
  staleMemberMs: 10 * 60_000,
};
const T0 = 1_000_000;

const room = () =>
  createRoomState({
    roomId: "r1",
    inviteCode: "ABCDEFGH",
    host: { memberId: "host", nickname: "房主", tokenHash: "h-host" },
    now: T0,
  });
const member = (id: string) => ({
  memberId: id,
  nickname: id,
  tokenHash: `h-${id}`,
});

describe("addMember", () => {
  test("邀請碼正確時加入成功", () => {
    const result = addMember(
      room(),
      { inviteCode: "ABCDEFGH", member: member("a") },
      new Set(),
      T0,
      config,
    );
    expect(result.ok && result.state.members.map((m) => m.role)).toEqual([
      "host",
      "member",
    ]);
  });

  test("邀請碼不符（已重新產生）與鎖房都回 ROOM_NOT_FOUND", () => {
    expect(
      addMember(
        room(),
        { inviteCode: "ZZZZZZZZ", member: member("a") },
        new Set(),
        T0,
        config,
      ),
    ).toEqual({ ok: false, code: "ROOM_NOT_FOUND" });
    expect(
      addMember(
        { ...room(), locked: true },
        { inviteCode: "ABCDEFGH", member: member("a") },
        new Set(),
        T0,
        config,
      ),
    ).toEqual({ ok: false, code: "ROOM_NOT_FOUND" });
  });

  test("滿員回 ROOM_FULL", () => {
    let state = room();
    for (const id of ["a", "b"]) {
      const r = addMember(
        state,
        { inviteCode: "ABCDEFGH", member: member(id) },
        new Set(),
        T0,
        config,
      );
      if (!r.ok) throw new Error("應該成功");
      state = r.state;
    }
    expect(
      addMember(
        state,
        { inviteCode: "ABCDEFGH", member: member("c") },
        new Set(["a", "b"]),
        T0,
        config,
      ),
    ).toEqual({ ok: false, code: "ROOM_FULL" });
  });

  test("離線太久的收看者會被移除，騰出名額；房主保留", () => {
    let state = room();
    for (const id of ["a", "b"]) {
      const r = addMember(
        state,
        { inviteCode: "ABCDEFGH", member: member(id) },
        new Set(),
        T0,
        config,
      );
      if (!r.ok) throw new Error("應該成功");
      state = r.state;
    }
    const later = T0 + config.staleMemberMs + 1;
    const r = addMember(
      state,
      { inviteCode: "ABCDEFGH", member: member("c") },
      new Set(["a"]),
      later,
      config,
    );
    expect(r.ok && r.state.members.map((m) => m.memberId)).toEqual([
      "host",
      "a",
      "c",
    ]);
  });
});

test("pruneStaleMembers 沒有變動時回傳同一個物件", () => {
  const state = room();
  expect(pruneStaleMembers(state, new Set(), T0, config)).toBe(state);
});

test("只有房主看得到邀請碼與換碼版本", () => {
  expect(toRoomInfo(room(), "host")).toMatchObject({
    inviteCode: "ABCDEFGH",
    inviteCodeVersion: 0,
  });
  expect(toRoomInfo(room(), "member")).not.toHaveProperty("inviteCode");
  expect(toRoomInfo(room(), "member")).not.toHaveProperty("inviteCodeVersion");
});

test("新房間用預設畫質；舊房間存的預設名稱送出時回到預設畫質", () => {
  expect(toRoomInfo(room(), "member").quality).toEqual(DEFAULT_QUALITY);
  const legacy = { ...room(), quality: "high" } as unknown as ReturnType<
    typeof room
  >;
  expect(toRoomInfo(legacy, "host").quality).toEqual(DEFAULT_QUALITY);
});

test("toMembers 依連線標示 online", () => {
  expect(toMembers(room(), new Set(["host"]))).toEqual([
    { memberId: "host", nickname: "房主", role: "host", online: true },
  ]);
});

describe("closeAt", () => {
  test("建房後沒人連線：閒置計時", () => {
    expect(closeAt(room(), config)).toBe(T0 + config.idleTtlMs);
  });
  test("有人在線：只看最長存活時間", () => {
    expect(closeAt({ ...room(), idleSince: null }, config)).toBe(
      T0 + config.maxAgeMs,
    );
  });
  test("取兩者中較早者", () => {
    const idleSince = T0 + config.maxAgeMs - 1000;
    expect(closeAt({ ...room(), idleSince }, config)).toBe(
      T0 + config.maxAgeMs,
    );
  });
  test("沒有成員時立即到期", () => {
    expect(closeAt({ ...room(), members: [], idleSince: null }, config)).toBe(
      0,
    );
  });
});

describe("房主離線計時與移除", () => {
  test("hostOf 無房主時回 undefined", () => {
    expect(hostOf(room())?.memberId).toBe("host");
    expect(hostOf(removeMember(room(), "host"))).toBeUndefined();
  });

  test("removeMember 移除房主時清除 hostDisconnectedAt 與該成員的 joinKeys", () => {
    const state = {
      ...room(),
      joinKeys: [
        {
          id: "k1",
          memberId: "host",
          tokenHash: "h-host",
          sealed: "s1",
          expiresAt: T0 + 10_000,
        },
        {
          id: "k2",
          memberId: "a",
          tokenHash: "h-a",
          sealed: "s2",
          expiresAt: T0 + 10_000,
        },
      ],
    };
    const next = removeMember(state, "host");
    expect(next.hostDisconnectedAt).toBeNull();
    expect(next.joinKeys?.map((k) => k.memberId)).toEqual(["a"]);
  });

  test("hostDisconnectedSince／hostRemoveAt：在線為 null，上版缺欄位回退至 host.lastSeenAt", () => {
    const base = room();
    expect(hostDisconnectedSince(base, new Set(["host"]))).toBeNull();
    expect(hostRemoveAt(base, new Set(["host"]), config)).toBeNull();
    expect(hostDisconnectedSince(base, new Set())).toBe(T0);
    expect(hostRemoveAt(base, new Set(), config)).toBe(
      T0 + config.hostOfflineTtlMs,
    );

    const legacy = { ...base, hostDisconnectedAt: undefined };
    expect(hostDisconnectedSince(legacy, new Set())).toBe(T0);
    expect(hostRemoveAt(legacy, new Set(), config)).toBe(
      T0 + config.hostOfflineTtlMs,
    );
  });
});

describe("findMemberByTokenHash", () => {
  test("比對所有成員，找不到回 undefined", () => {
    const room = createRoomState({
      roomId: "r",
      inviteCode: "ABCDEFGH",
      host: { memberId: "host", nickname: "房主", tokenHash: "hash-host" },
      now: 0,
    });
    expect(findMemberByTokenHash(room, "hash-host")?.memberId).toBe("host");
    expect(findMemberByTokenHash(room, "hash-hosT")).toBeUndefined();
    expect(findMemberByTokenHash(room, "hash")).toBeUndefined();
  });

  test("不論命中第幾位，都會比完全部成員（三位以上）", () => {
    const base = room();
    const visited: string[] = [];
    const ids = ["host", "a", "b", "c"];
    const hashOf = (id: string) => id.padEnd(43, "x");
    const members = ids.map((memberId, i): MemberRecord => {
      const record = {
        ...base.members[0]!,
        memberId,
        role: i === 0 ? ("host" as const) : ("member" as const),
      };
      Object.defineProperty(record, "tokenHash", {
        get: () => {
          visited.push(memberId);
          return hashOf(memberId);
        },
      });
      return record;
    });
    const state = { ...base, members };
    for (const target of ["host", "b", "nobody"]) {
      visited.length = 0;
      expect(findMemberByTokenHash(state, hashOf(target))?.memberId).toBe(
        target === "nobody" ? undefined : target,
      );
      expect(visited).toEqual(ids);
    }
  });
});

describe("crypto", () => {
  test("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  test("產生的邀請碼都合法", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(normalizeInviteCode(code)).toBe(code);
    }
  });
  test("isRoomId 只接受 UUID", () => {
    expect(isRoomId(crypto.randomUUID())).toBe(true);
    expect(isRoomId("../../etc")).toBe(false);
  });
});
