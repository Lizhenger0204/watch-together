import { describe, expect, test } from "vitest";
import {
  addMember,
  closeAt,
  createRoomState,
  findMemberByTokenHash,
  pruneStaleMembers,
  toMembers,
  toRoomInfo,
} from "../src/room/room";
import {
  generateInviteCode,
  isRoomId,
  timingSafeEqual,
} from "../src/room/crypto";
import { normalizeInviteCode } from "@project/shared";

const config = {
  maxMembers: 3,
  idleTtlMs: 30 * 60_000,
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

test("只有房主看得到邀請碼", () => {
  expect(toRoomInfo(room(), "host").inviteCode).toBe("ABCDEFGH");
  expect(toRoomInfo(room(), "member")).not.toHaveProperty("inviteCode");
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
