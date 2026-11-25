import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JOIN_MAX_EXCLUDED_ROOMS } from "@project/shared";
import { ApiError } from "../../lib/api";
import {
  resetMemoryStorage,
  roomInviteCode,
  roomToken,
} from "../../lib/storage";
import {
  checkIdentity,
  joinKeepingIdentity,
  resetComparedRooms,
} from "./identity";
import {
  CODE,
  NEW_TOKEN,
  OTHER,
  ROOM,
  ROTATED,
  TOKEN,
  mockApi,
  persistedTokens,
} from "./identity.fixtures";

beforeEach(() => {
  resetMemoryStorage();
  resetComparedRooms();
});
afterEach(() => vi.unstubAllGlobals());

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

  test("配位後核對舊身份期間，保留其他分頁剛寫入的新身份", async () => {
    persistedTokens([]);
    const key = `room:${ROOM}:token`;
    const request = vi.fn<typeof fetch>(async (path, init) => {
      if (path === "/api/rooms/join") {
        localStorage.setItem(key, TOKEN);
        return Response.json({
          roomId: ROOM,
          memberId: "viewer",
          memberToken: crypto.randomUUID(),
        });
      }
      expect(path).toBe(`/api/rooms/${ROOM}/ice`);
      if (
        new Headers(init?.headers).get("Authorization") ===
        "Bearer " + TOKEN
      ) {
        localStorage.setItem(key, NEW_TOKEN);
        return new Response(null, { status: 401 });
      }
      expect(
        new Headers(init?.headers).get("Authorization") ===
          "Bearer " + NEW_TOKEN,
      ).toBe(true);
      return Response.json({ iceServers: [] });
    });
    vi.stubGlobal("fetch", request);
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(localStorage.getItem(key)).toBe(NEW_TOKEN);
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

  test.each([false, true])(
    "房主憑證只在記憶體（建房時存不進去）：換碼後點新碼沿用，不多佔一席（鎖房 %s）",
    async (locked) => {
      const api = mockApi({ locked });
      // 新分頁：沒有經過本分頁加入流程，也沒有 localStorage。
      vi.resetModules();
      const storage = await import("../../lib/storage");
      const tab = await import("./identity");
      storage.roomToken.set(ROOM, TOKEN);
      storage.roomInviteCode.set(ROOM, CODE);
      api.rotate();
      await expect(tab.joinKeepingIdentity(ROTATED, "房主")).resolves.toEqual({
        roomId: ROOM,
        reused: true,
      });
      expect(api.admissions()).toBe(0);
      expect(storage.roomToken.get(ROOM)).toBe(TOKEN);
    },
  );

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

  test("自然淘汰後持新碼明確重送，只重新配置一席", async () => {
    const api = mockApi();
    await joinKeepingIdentity(CODE, "朋友");
    api.evict();
    api.rotate();
    const before = api.admissions();
    await expect(joinKeepingIdentity(ROTATED, "朋友")).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
      message: "先前保存的房間身份已失效，請再按一次「加入」。",
    });
    await expect(joinKeepingIdentity(ROTATED, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    await expect(joinKeepingIdentity(ROTATED, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(api.admissions() - before).toBe(1);
  });

  test.each([200, 503])(
    "錯碼沿用回 404，獨立 ICE %i 保留原憑證",
    async (status) => {
      persistedTokens([[ROOM, TOKEN]]);
      const api = mockApi();
      api.ice(status);
      await expect(joinKeepingIdentity(ROTATED, "朋友")).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(api.fetcher.mock.lastCall?.[0]).toBe(`/api/rooms/${ROOM}/ice`);
      expect(roomToken.get(ROOM)).toBe(TOKEN);
      expect(api.admissions()).toBe(0);
    },
  );

  test("滿房 409 仍可沿用同房身份，其他房的成員仍看到滿房", async () => {
    persistedTokens([[OTHER, NEW_TOKEN]]);
    const api = mockApi({ full: true });
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    roomToken.set(ROOM, TOKEN);
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(api.admissions()).toBe(0);
  });

  test("換碼後，快取的舊連結只憑有效身份回房", async () => {
    const api = mockApi();
    await joinKeepingIdentity(CODE, "朋友");
    api.rotate();
    api.fetcher.mockClear();
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(api.fetcher).toHaveBeenCalledOnce();
    expect(api.fetcher.mock.lastCall?.[0]).toBe(`/api/rooms/${ROOM}/ice`);
    api.evict();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });
    expect(api.admissions()).toBe(1);
  });

  test("舊分頁已清除身份，取得加入鎖後沿用另一分頁剛配的席位", async () => {
    persistedTokens([]);
    const api = mockApi();
    await joinKeepingIdentity(CODE, "朋友");
    api.evict();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(roomToken.get(ROOM)).toBeNull();
    api.rotate();

    vi.resetModules();
    const otherTab = await import("./identity");
    let queue: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, enter: () => Promise<unknown>) => {
      const next = queue.then(enter);
      queue = next.catch(() => {});
      return next;
    });
    vi.stubGlobal("navigator", { locks: { request } });
    const before = api.admissions();
    const [fresh, old] = await Promise.all([
      otherTab.joinKeepingIdentity(ROTATED, "朋友"),
      joinKeepingIdentity(ROTATED, "朋友"),
    ]);
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      "room:join",
      "room:join",
    ]);
    expect(fresh.reused).toBe(false);
    expect(old.reused).toBe(true);
    expect(api.admissions() - before).toBe(1);
    expect(api.fetcher.mock.lastCall?.[0]).toBe(`/api/rooms/${ROOM}/ice`);
    expect(localStorage.getItem(`room:${ROOM}:token`)).toBe(NEW_TOKEN);
    expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
  });

  test("超過名單上限，仍可沿用排列在界外的有效身份", async () => {
    const ids = Array.from({ length: JOIN_MAX_EXCLUDED_ROOMS }, () =>
      crypto.randomUUID(),
    );
    persistedTokens([
      ...ids.map((id): [string, string] => [id, NEW_TOKEN]),
      [ROOM, TOKEN],
    ]);
    const api = mockApi();
    vi.resetModules();
    const tab = await import("./identity");
    await expect(tab.joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(api.admissions()).toBe(0);
    for (const [path, init] of api.fetcher.mock.calls) {
      if (path === "/api/rooms/join")
        expect(JSON.parse(String(init?.body))).toHaveProperty("existingRoomId");
    }
  });

  test("超限時清除已失效身份，完整排除其餘 16 房後才能配位", async () => {
    const ids = Array.from({ length: JOIN_MAX_EXCLUDED_ROOMS }, () =>
      crypto.randomUUID(),
    );
    persistedTokens([
      [ROOM, TOKEN],
      ...ids.map((id): [string, string] => [id, NEW_TOKEN]),
    ]);
    const api = mockApi({ revoked: true });
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    const joins = api.fetcher.mock.calls.filter(
      ([path]) => path === "/api/rooms/join",
    );
    expect(joins).toHaveLength(1);
    expect(JSON.parse(String(joins[0]?.[1]?.body)).excludeRoomIds).toEqual(
      expect.arrayContaining(ids),
    );
    expect(JSON.parse(String(joins[0]?.[1]?.body)).excludeRoomIds).toHaveLength(
      ids.length,
    );
    expect(api.admissions()).toBe(1);
    expect(roomToken.get(ROOM)).toBe(NEW_TOKEN);
  });

  test("超限且各房身份都有效，加入不同房間時保留全部憑證", async () => {
    const ids = Array.from({ length: JOIN_MAX_EXCLUDED_ROOMS + 1 }, () =>
      crypto.randomUUID(),
    );
    persistedTokens(ids.map((id) => [id, NEW_TOKEN]));
    const api = mockApi();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("16"),
    });
    expect(api.admissions()).toBe(0);
    expect(ids.every((id) => roomToken.get(id) === NEW_TOKEN)).toBe(true);
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
