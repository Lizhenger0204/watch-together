import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JOIN_MAX_EXCLUDED_ROOMS } from "@project/shared";
import { resetMemoryStorage, roomToken } from "../../lib/storage";
import { FakeIndexedDB } from "../../lib/tab-lock.fixtures";
import { comparedRooms } from "./compared-rooms";
import { joinKeepingIdentity, resetComparedRooms } from "./identity";
import { CODE, ROTATED, mockApi, persistedTokens } from "./identity.fixtures";

// 加入限流與跨分頁協調：持有多房身份時的逐房比對、沒有 Web Locks 時的 IndexedDB 租約。

beforeEach(() => {
  resetMemoryStorage();
  resetComparedRooms();
});
afterEach(() => vi.unstubAllGlobals());

describe("跨限流時窗", () => {
  /** 每時窗 10 次 join；本房已滿，其他房都不是這個碼的房間。 */
  function rateLimitedApi(full: boolean) {
    let used = 0;
    const joins: { existingRoomId?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (path, init) => {
        if (String(path).endsWith("/ice"))
          return Response.json({ iceServers: [] });
        const body = JSON.parse(String(init?.body));
        if (++used > 10)
          return Response.json(
            { error: { code: "RATE_LIMITED", message: "" } },
            { status: 429 },
          );
        joins.push(body);
        if (!body.existingRoomId && full)
          return Response.json(
            { error: { code: "ROOM_FULL", message: "" } },
            { status: 409 },
          );
        return Response.json(
          { error: { code: "ROOM_NOT_FOUND", message: "" } },
          { status: 404 },
        );
      }),
    );
    return {
      reuseAttempts: () => joins.filter((b) => b.existingRoomId).length,
      nextWindow: () => {
        used = 0;
        joins.length = 0;
      },
    };
  }

  test("持有 12 房身份遇到滿房：記住已比對的房間，比完後回傳滿房", async () => {
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
    persistedTokens(ids.map((id) => [id, crypto.randomUUID()]));
    const api = rateLimitedApi(true);
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(api.reuseAttempts()).toBe(9);

    api.nextWindow();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    expect(api.reuseAttempts()).toBe(3);

    // 都比對過了：不再逐房沿用，直接回原本的滿房（只送一次新加入）。
    api.nextWindow();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    expect(api.reuseAttempts()).toBe(0);
    expect(ids.every((id) => roomToken.get(id))).toBe(true);
  });

  test("超過 16 房的名單上限：比完後回傳超限提示，不再從頭比對", async () => {
    const ids = Array.from({ length: JOIN_MAX_EXCLUDED_ROOMS + 1 }, () =>
      crypto.randomUUID(),
    );
    persistedTokens(ids.map((id) => [id, crypto.randomUUID()]));
    const api = rateLimitedApi(false);
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(api.reuseAttempts()).toBe(10);
    api.nextWindow();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(api.reuseAttempts()).toBe(ids.length - 10);
    api.nextWindow();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(api.reuseAttempts()).toBe(0);
  });

  test("換成另一個邀請碼：重新比對", async () => {
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    persistedTokens(ids.map((id) => [id, crypto.randomUUID()]));
    const api = rateLimitedApi(true);
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    api.nextWindow();
    await expect(joinKeepingIdentity(ROTATED, "朋友")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    expect(api.reuseAttempts()).toBe(3);
  });
});

describe("沒有 Web Locks 的跨分頁加入", () => {
  test("另一分頁等第一筆加入存好身份後才重讀，只配置一席", async () => {
    persistedTokens([]);
    const api = mockApi();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("indexedDB", new FakeIndexedDB());
    vi.resetModules();
    const otherTab = await import("./identity");
    const joined = await Promise.all([
      otherTab.joinKeepingIdentity(CODE, "朋友"),
      joinKeepingIdentity(CODE, "朋友"),
    ]);
    expect(api.admissions()).toBe(1);
    expect(joined.map((j) => j.reused).sort()).toEqual([false, true]);
  });
});

describe("比對紀錄的淘汰", () => {
  test("確認失效而清除的身份，從比對紀錄淘汰", async () => {
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    persistedTokens(ids.map((id) => [id, crypto.randomUUID()]));
    let expired: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (path, init) => {
        if (String(path).endsWith("/ice")) {
          return expired && String(path).includes(expired)
            ? Response.json(
                { error: { code: "UNAUTHORIZED", message: "" } },
                { status: 401 },
              )
            : Response.json({ iceServers: [] });
        }
        const body = JSON.parse(String(init?.body));
        return body.existingRoomId
          ? Response.json(
              { error: { code: "ROOM_NOT_FOUND", message: "" } },
              { status: 404 },
            )
          : Response.json(
              { error: { code: "ROOM_FULL", message: "" } },
              { status: 409 },
            );
      }),
    );
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    expect(comparedRooms.entries()).toEqual([[CODE, ids]]);
    // 另一個邀請碼比對時發現 ids[0] 失效：清除身份，也從 CODE 的紀錄淘汰。
    expired = ids[0]!;
    await expect(joinKeepingIdentity(ROTATED, "朋友")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    expect(roomToken.get(ids[0]!)).toBeNull();
    expect(comparedRooms.entries()).toEqual([
      [CODE, ids.slice(1)],
      [ROTATED, ids.slice(1)],
    ]);
  });
});
