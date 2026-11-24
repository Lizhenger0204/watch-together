import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import {
  resetMemoryStorage,
  roomInviteCode,
  roomToken,
} from "../../lib/storage";
import { checkIdentity, joinKeepingIdentity } from "./identity";

const ROOM = "0b6f6e2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const HOST_TOKEN = "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_TOKEN = "member-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

beforeEach(() => resetMemoryStorage());

function deps(valid: Record<string, boolean>) {
  return {
    join: vi.fn(async () => ({
      roomId: ROOM,
      memberToken: NEW_TOKEN,
      memberId: "m2",
    })),
    check: vi.fn(async (_roomId: string, token: string) =>
      valid[token] ? ("valid" as const) : ("unauthorized" as const),
    ),
  };
}

describe("joinKeepingIdentity（房主開自己的邀請連結）", () => {
  test("認得這組邀請碼、舊身份仍有效：直接回房，不呼叫加入", async () => {
    roomToken.set(ROOM, HOST_TOKEN);
    roomInviteCode.set(ROOM, "ABCDEFGH");
    const d = deps({ [HOST_TOKEN]: true });
    await expect(joinKeepingIdentity("ABCDEFGH", "小明", d)).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(d.join).not.toHaveBeenCalled();
    expect(roomToken.get(ROOM)).toBe(HOST_TOKEN);
  });

  test("加入回來的房間已有仍有效的 token：保留舊 token，不覆寫", async () => {
    roomToken.set(ROOM, HOST_TOKEN);
    const d = deps({ [HOST_TOKEN]: true });
    await expect(joinKeepingIdentity("ZZZZZZZZ", "小明", d)).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(roomToken.get(ROOM)).toBe(HOST_TOKEN);
  });

  test("舊 token 確認失效後才換成新的", async () => {
    roomToken.set(ROOM, HOST_TOKEN);
    roomInviteCode.set(ROOM, "ABCDEFGH");
    const d = deps({});
    await expect(joinKeepingIdentity("ABCDEFGH", "小明", d)).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    expect(d.join).toHaveBeenCalledWith("ABCDEFGH", "小明");
    expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
  });

  test("沒有舊身份：照常加入並存 token", async () => {
    const d = deps({});
    await joinKeepingIdentity("ABCDEFGH", "小明", d);
    expect(d.check).not.toHaveBeenCalled();
    expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
  });

  test("無法確認舊身份（網路錯誤）時不覆寫", async () => {
    roomToken.set(ROOM, HOST_TOKEN);
    const d = deps({});
    d.check.mockResolvedValue("unknown" as never);
    await expect(joinKeepingIdentity("ABCDEFGH", "小明", d)).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(roomToken.get(ROOM)).toBe(HOST_TOKEN);
  });
});

describe("joinKeepingIdentity（收看者重複點邀請連結）", () => {
  test("第一次加入後記住對照，再點同一個邀請連結不再呼叫加入", async () => {
    const d = deps({ [NEW_TOKEN]: true });
    await joinKeepingIdentity("ABCDEFGH", "小明", d);
    expect(roomInviteCode.findRoom("ABCDEFGH")).toBe(ROOM);

    await expect(joinKeepingIdentity("ABCDEFGH", "小明", d)).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(d.join).toHaveBeenCalledTimes(1);
    expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
  });

  test("沿用既有身份時也記住新的邀請碼（房主重產後收看者點新連結）", async () => {
    roomToken.set(ROOM, HOST_TOKEN);
    const d = deps({ [HOST_TOKEN]: true });
    await joinKeepingIdentity("NEWCODE2", "小明", d);
    expect(roomInviteCode.findRoom("NEWCODE2")).toBe(ROOM);

    await joinKeepingIdentity("NEWCODE2", "小明", d);
    expect(d.join).toHaveBeenCalledTimes(1);
  });

  test("記住的身份已失效：重新加入並換成新 token", async () => {
    const d = deps({});
    await joinKeepingIdentity("ABCDEFGH", "小明", d);
    await joinKeepingIdentity("ABCDEFGH", "小明", d);
    expect(d.join).toHaveBeenCalledTimes(2);
    expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
  });
});

describe("checkIdentity", () => {
  test.each([
    [null, "valid"],
    ["UNAUTHORIZED", "unauthorized"],
    ["ROOM_NOT_FOUND", "room_closed"],
    ["INTERNAL", "unknown"],
  ] as const)("ICE API 回 %s → %s", async (code, expected) => {
    const getIce = vi.fn(async () => {
      if (code) throw new ApiError(code);
      return { iceServers: [] };
    });
    await expect(checkIdentity(ROOM, HOST_TOKEN, getIce)).resolves.toBe(
      expected,
    );
    expect(getIce).toHaveBeenCalledWith(ROOM, HOST_TOKEN);
  });
});
