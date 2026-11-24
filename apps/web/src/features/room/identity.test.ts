import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import {
  resetMemoryStorage,
  roomInviteCode,
  roomToken,
} from "../../lib/storage";
import { checkIdentity, joinKeepingIdentity } from "./identity";

const ROOM = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const TOKEN = crypto.randomUUID();
const NEW_TOKEN = crypto.randomUUID();
const CODE = "ABCDEFGH";
const ROTATED = "XYZW2345";

beforeEach(() => resetMemoryStorage());
afterEach(() => vi.unstubAllGlobals());

function mockApi({ locked = false, revoked = false } = {}) {
  let code = CODE;
  let admissions = 0;
  let iceStatus = 200;
  const fail = (status: number, code: string) =>
    Response.json({ error: { code, message: "測試錯誤" } }, { status });
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    if (String(path).endsWith("/ice")) {
      if (!iceStatus) throw new TypeError("offline");
      return iceStatus === 200
        ? Response.json({ iceServers: [] })
        : fail(
            iceStatus,
            iceStatus === 401
              ? "UNAUTHORIZED"
              : iceStatus === 404
                ? "ROOM_NOT_FOUND"
                : "INTERNAL",
          );
    }
    expect(path).toBe("/api/rooms/join");
    const body: {
      inviteCode: string;
      existingRoomId?: string;
      excludeRoomIds?: string[];
    } = JSON.parse(String(init?.body));
    const auth = new Headers(init?.headers).get("Authorization");
    const result = (memberToken: string) =>
      Response.json({ roomId: ROOM, memberId: "member", memberToken });
    if (body.inviteCode !== code) return fail(404, "ROOM_NOT_FOUND");
    if (auth === "Bearer " + TOKEN && body.existingRoomId === ROOM && !revoked)
      return Response.json({ roomId: ROOM, memberId: "member", reused: true });
    if (
      body.existingRoomId ||
      auth ||
      body.excludeRoomIds?.includes(ROOM) ||
      locked
    )
      return fail(404, "ROOM_NOT_FOUND");
    admissions++;
    return result(admissions === 1 ? TOKEN : NEW_TOKEN);
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    admissions: () => admissions,
    rotate: () => {
      code = ROTATED;
    },
    ice: (status: number) => {
      iceStatus = status;
    },
  };
}

function persistedTokens(entries: [string, string][]) {
  const values = new Map(
    entries.map(([id, token]) => [`room:${id}:token`, token]),
  );
  vi.stubGlobal("localStorage", {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
}

describe("joinKeepingIdentity", () => {
  test.each([503, 0])(
    "已記住的邀請碼遇到 ICE %s：保留席位並讓使用者重試",
    async (status) => {
      const api = mockApi();
      await expect(joinKeepingIdentity(CODE, "小明")).resolves.toEqual({
        roomId: ROOM,
        reused: false,
      });
      api.ice(status);
      await expect(joinKeepingIdentity(CODE, "小明")).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(roomToken.get(ROOM)).toBe(TOKEN);
      expect(roomInviteCode.findRoom(CODE)).toBe(ROOM);
      api.ice(200);
      await expect(joinKeepingIdentity(CODE, "小明")).resolves.toEqual({
        roomId: ROOM,
        reused: true,
      });
      expect(api.admissions()).toBe(1);
      expect(
        api.fetcher.mock.calls.filter(([path]) => path === "/api/rooms/join"),
      ).toHaveLength(1);
    },
  );

  test("503 即使附帶 UNAUTHORIZED 錯誤碼也保留原身份", async () => {
    roomToken.set(ROOM, TOKEN);
    roomInviteCode.set(ROOM, CODE);
    const request = vi.fn(async () =>
      Response.json(
        { error: { code: "UNAUTHORIZED", message: "" } },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", request);
    await expect(joinKeepingIdentity(CODE, "小明")).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(roomToken.get(ROOM)).toBe(TOKEN);
  });

  test("舊驗證晚到的 401 保留另一分頁新寫的憑證", async () => {
    persistedTokens([[ROOM, TOKEN]]);
    roomToken.set(ROOM, TOKEN);
    roomInviteCode.set(ROOM, CODE);
    vi.stubGlobal("fetch", async () => {
      localStorage.setItem(`room:${ROOM}:token`, NEW_TOKEN);
      return new Response(null, { status: 401 });
    });
    await expect(joinKeepingIdentity(CODE, "小明")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(localStorage.getItem(`room:${ROOM}:token`)).toBe(NEW_TOKEN);
    expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
  });

  test("同一分頁同時首次提交兩次只配置一席", async () => {
    const api = mockApi();
    const joined = await Promise.all([
      joinKeepingIdentity(CODE, "小明"),
      joinKeepingIdentity(CODE, "小明"),
    ]);
    expect(joined[0]).toEqual(joined[1]);
    expect(api.admissions()).toBe(1);
  });

  test("無 localStorage 時，換碼也在配置前認出本分頁的原成員", async () => {
    const api = mockApi();
    await joinKeepingIdentity(CODE, "小明");
    api.rotate();
    await expect(joinKeepingIdentity(ROTATED, "小明")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(api.admissions()).toBe(1);
    expect(roomInviteCode.findRoom(ROTATED)).toBe(ROOM);
    expect(roomToken.get(ROOM)).toBe(TOKEN);
    await joinKeepingIdentity(ROTATED, "小明");
    expect(String(api.fetcher.mock.lastCall?.[0])).toMatch(/\/ice$/);
  });

  test("讀取改版前已儲存的多房身份：鎖房後點新碼仍保留同房 token", async () => {
    const otherToken = crypto.randomUUID();
    persistedTokens([
      [OTHER, otherToken],
      [ROOM, TOKEN],
    ]);
    const api = mockApi({ locked: true });
    api.rotate();
    await expect(joinKeepingIdentity(ROTATED, "小明")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(api.admissions()).toBe(0);
    for (const [url, init] of api.fetcher.mock.calls) {
      for (const token of [TOKEN, otherToken]) {
        expect(
          String(url).includes(token) || String(init?.body).includes(token),
        ).toBe(false);
      }
    }
    expect(roomToken.get(ROOM)).toBe(TOKEN);
    expect(roomToken.get(OTHER)).toBe(otherToken);
  });

  test("持有其他房間的身份仍能加入新房", async () => {
    persistedTokens([[OTHER, crypto.randomUUID()]]);
    const api = mockApi();
    await expect(joinKeepingIdentity(CODE, "小明")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    expect(api.admissions()).toBe(1);
  });

  test("未知新碼搭配已撤銷憑證，不退回匿名配位", async () => {
    persistedTokens([[ROOM, TOKEN]]);
    const api = mockApi({ revoked: true });
    api.rotate();
    await expect(joinKeepingIdentity(ROTATED, "小明")).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });
    expect(api.admissions()).toBe(0);
  });

  test.each([401, 404])(
    "已知邀請碼只有明確的 ICE %i 才捨棄舊身份，本次不另配位",
    async (status) => {
      const api = mockApi();
      await joinKeepingIdentity(CODE, "小明");
      api.ice(status);
      await expect(joinKeepingIdentity(CODE, "小明")).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(roomToken.get(ROOM)).toBeNull();
      expect(api.admissions()).toBe(1);
      await expect(joinKeepingIdentity(CODE, "小明")).resolves.toMatchObject({
        reused: false,
      });
      expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
    },
  );
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
    await expect(checkIdentity(ROOM, TOKEN, getIce)).resolves.toBe(expected);
    expect(getIce).toHaveBeenCalledWith(ROOM, TOKEN);
  });

  test("同房同憑證共用在途的 ICE 請求，換憑證不共用，完成後可重新驗證", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getIce = vi.fn(async () => {
      await gate;
      return { iceServers: [] };
    });
    const first = checkIdentity(ROOM, TOKEN, getIce);
    const second = checkIdentity(ROOM, TOKEN, getIce);
    const other = checkIdentity(ROOM, NEW_TOKEN, getIce);
    expect(getIce).toHaveBeenCalledTimes(2);
    release();
    expect(await Promise.all([first, second, other])).toEqual([
      "valid",
      "valid",
      "valid",
    ]);
    await checkIdentity(ROOM, TOKEN, getIce);
    expect(getIce).toHaveBeenCalledTimes(3);
  });
});
