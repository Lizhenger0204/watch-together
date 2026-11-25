import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JOIN_KEY_TTL_MS, joinKeySchema } from "@project/shared";
import {
  pendingJoinKey,
  resetMemoryStorage,
  roomInviteCode,
  roomToken,
} from "../../lib/storage";
import { joinKeepingIdentity, resetComparedRooms } from "./identity";
import {
  CODE,
  ROOM,
  ROTATED,
  TOKEN,
  mockApi,
  persistedTokens,
} from "./identity.fixtures";

// protocol.md「加入冪等」：每次新加入產生一把 joinKey，送出前存進共用儲存；
// 結果未明時重試與接手分頁沿用同一把鍵；成功保存、沿用或確定未配位時條件清除。

const keyStorage = `join:${CODE}:key`;
/** 用布林判斷待完成鍵是否存在，避免斷言失敗時在輸出中印出金鑰內容。 */
const hasStoredKey = (inviteCode = CODE) =>
  localStorage.getItem(`join:${inviteCode}:key`) !== null;

beforeEach(() => {
  resetMemoryStorage();
  resetComparedRooms();
  persistedTokens([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 假伺服器：同一把鍵回同一份結果；`loseResponse` 時配好席位但回應遺失。 */
function idempotentServer() {
  const seats = new Map<string, string>();
  const sent: (string | undefined)[] = [];
  const redirects: (RequestRedirect | undefined)[] = [];
  let loseNext = false;
  let nextError: { status: number; code: string } | null = null;
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    expect(String(path)).toBe("/api/rooms/join");
    redirects.push(init?.redirect);
    const body: { joinKey?: string } = JSON.parse(String(init?.body));
    sent.push(body.joinKey);
    // 鍵在送出前就已寫入（正常儲存時可在共用儲存讀到）。
    const stored = localStorage.getItem(keyStorage);
    if (stored !== null) {
      expect(Boolean(body.joinKey && stored.includes(body.joinKey))).toBe(true);
    }
    if (nextError) {
      const err = nextError;
      nextError = null;
      return Response.json(
        { error: { code: err.code, message: "測試錯誤" } },
        { status: err.status },
      );
    }
    let token = body.joinKey && seats.get(body.joinKey);
    if (!token) {
      token = crypto.randomUUID();
      if (body.joinKey) seats.set(body.joinKey, token);
    }
    if (loseNext) {
      loseNext = false;
      throw new TypeError("connection reset");
    }
    return Response.json({ roomId: ROOM, memberId: "m", memberToken: token });
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    sent,
    redirects,
    seats: () => seats.size,
    loseResponse: () => {
      loseNext = true;
    },
    failNext: (status: number, code: string) => {
      nextError = { status, code };
    },
  };
}

describe("加入冪等鍵", () => {
  test("回應遺失後重試：沿用同一把鍵，只配一席，且一般加入路徑也禁用轉址", async () => {
    const server = idempotentServer();
    server.loseResponse();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    expect(server.seats()).toBe(1);
    expect(server.sent.length).toBe(2);
    expect(server.sent[1] === server.sent[0]).toBe(true);
    expect(server.redirects).toEqual(["error", "error"]);
    expect(joinKeySchema.safeParse(server.sent[0]).success).toBe(true);
    // 身份存好後刪除鍵；下一次加入是新的一次。
    expect(hasStoredKey()).toBe(false);
  });

  test("分頁在保存身份前關閉：接手的分頁讀到同一把鍵", async () => {
    const server = idempotentServer();
    server.loseResponse(); // 等同第一個分頁拿到回應前就關掉
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toBeDefined();
    vi.resetModules();
    const otherTab = await import("./identity");
    const storage = await import("../../lib/storage");
    await expect(otherTab.joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    expect(server.seats()).toBe(1);
    expect(server.sent[1] === server.sent[0]).toBe(true);
    expect(Boolean(storage.roomToken.get(ROOM))).toBe(true);
    expect(hasStoredKey()).toBe(false);
  });

  test("超過期限的鍵不再使用並清掉其他邀請碼的逾期鍵", async () => {
    const server = idempotentServer();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    pendingJoinKey.set(ROTATED, crypto.randomUUID(), 1_000_000);
    server.loseResponse();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toBeDefined();
    vi.setSystemTime(1_000_000 + JOIN_KEY_TTL_MS);
    await joinKeepingIdentity(CODE, "朋友");
    expect(server.sent[1] === server.sent[0]).toBe(false);
    expect(hasStoredKey(ROTATED)).toBe(false);
  });

  test("成功加入後再加入另一房：每次按加入都是新的鍵", async () => {
    const server = idempotentServer();
    await joinKeepingIdentity(CODE, "朋友");
    roomToken.clear(ROOM);
    await joinKeepingIdentity(CODE, "朋友");
    expect(server.sent[1] === server.sent[0]).toBe(false);
  });

  test.each([
    [404, "ROOM_NOT_FOUND"],
    [409, "ROOM_FULL"],
    [429, "RATE_LIMITED"],
  ] as const)(
    "新加入明確收到 %i（%s）時清除待完成鍵，下次按加入改用新鍵",
    async (status, code) => {
      const server = idempotentServer();
      server.failNext(status, code);
      await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
        code,
      });
      expect(hasStoredKey()).toBe(false);
      await joinKeepingIdentity(CODE, "朋友");
      expect(server.sent[1] === server.sent[0]).toBe(false);
    },
  );

  test("先前結果未明的待完成鍵重試時遇到 429 限流：保留鍵，稍後重試仍只配一席", async () => {
    const server = idempotentServer();
    server.loseResponse();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "INTERNAL",
    });
    server.failNext(429, "RATE_LIMITED");
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(hasStoredKey()).toBe(true);
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    expect(server.seats()).toBe(1);
    expect(server.sent[2] === server.sent[0]).toBe(true);
    expect(hasStoredKey()).toBe(false);
  });

  test("換碼後透過 existingRoomId 成功沿用身份：不留待完成鍵", async () => {
    persistedTokens([[ROOM, TOKEN]]);
    const api = mockApi();
    api.rotate();
    await expect(joinKeepingIdentity(ROTATED, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: true,
    });
    expect(hasStoredKey(ROTATED)).toBe(false);
  });

  test("寫入共用儲存持續失敗時：成功加入後清除記憶體鍵；鍵已持久化但憑證存不進去時保留持久鍵", async () => {
    const server = idempotentServer();
    const denyAll = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    denyAll.mockRestore();
    // 鍵沒持久化：成功後記憶體鍵已清掉，清掉憑證再加入會產生新鍵。
    expect(pendingJoinKey.get(CODE, JOIN_KEY_TTL_MS) === null).toBe(true);
    roomToken.clear(ROOM);

    // 鍵寫得進去，但之後寫憑證失敗：保留已持久化的鍵，讓重整或別的分頁仍可取回同一席。
    let writes = 0;
    const realSetItem = localStorage.setItem.bind(localStorage);
    const denySecond = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((k, v) => {
        if (++writes >= 2) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        realSetItem(k, v);
      });
    await expect(joinKeepingIdentity(CODE, "朋友")).resolves.toEqual({
      roomId: ROOM,
      reused: false,
    });
    denySecond.mockRestore();
    expect(server.sent[1] === server.sent[0]).toBe(false);
    expect(hasStoredKey()).toBe(true);
  });

  test("雙分頁回歸：甲頁以舊碼沿用身份期間乙頁換碼，甲頁晚到的回應不可覆寫新版邀請碼對照", async () => {
    // 初始狀態：已保存房主憑證，但缺少邀請碼對照。
    persistedTokens([[ROOM, TOKEN]]);
    let releaseReuse!: () => void;
    const reuseGate = new Promise<void>((resolve) => {
      releaseReuse = resolve;
    });
    let reuseInFlight!: () => void;
    const reuseStarted = new Promise<void>((resolve) => {
      reuseInFlight = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (path, init) => {
        expect(String(path)).toBe("/api/rooms/join");
        const body: {
          inviteCode: string;
          existingRoomId?: string;
          excludeRoomIds?: string[];
        } = JSON.parse(String(init?.body));
        if (body.existingRoomId === ROOM) {
          reuseInFlight();
          await reuseGate;
          return Response.json({
            roomId: ROOM,
            memberId: "host",
            reused: true,
          });
        }
        // 新加入請求命中 excludeRoomIds → 404，進入 existingRoomId 沿用。
        return Response.json(
          { error: { code: "ROOM_NOT_FOUND", message: "找不到房間" } },
          { status: 404 },
        );
      }),
    );

    // 甲頁以舊碼沿用身份，但 REST 回應暫緩交付。
    const tabAJoin = joinKeepingIdentity(CODE, "房主");
    await reuseStarted;

    // 乙頁隨後換碼，把新版邀請碼寫入共用儲存。
    localStorage.setItem(`room:${ROOM}:invite`, `${ROTATED}:1`);

    // 放行甲頁的晚到回應。
    releaseReuse();
    await expect(tabAJoin).resolves.toEqual({ roomId: ROOM, reused: true });

    // 共用儲存必須維持乙頁寫入的新版對照，不可退回無版本的舊碼。
    expect(localStorage.getItem(`room:${ROOM}:invite`)).toBe(`${ROTATED}:1`);
    expect(roomInviteCode.findRoom(ROTATED)).toBe(ROOM);
    expect(roomInviteCode.findRoom(CODE)).toBeNull();
  });
});
