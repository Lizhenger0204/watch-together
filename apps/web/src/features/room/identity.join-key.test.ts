import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JOIN_KEY_TTL_MS, joinKeySchema } from "@project/shared";
import { resetMemoryStorage, roomToken } from "../../lib/storage";
import { joinKeepingIdentity, resetComparedRooms } from "./identity";
import { CODE, ROOM, persistedTokens } from "./identity.fixtures";

// protocol.md「加入冪等」：每次按加入產生一把 joinKey，送出前存進共用儲存；
// 回應遺失或分頁在保存身份前關閉，重試與接手的分頁都沿用同一把鍵，只配一席。

const keyStorage = `join:${CODE}:key`;

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
  let loseNext = false;
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    expect(String(path)).toBe("/api/rooms/join");
    const body: { joinKey?: string } = JSON.parse(String(init?.body));
    sent.push(body.joinKey);
    // 鍵在送出前就已存進共用儲存。
    expect(localStorage.getItem(keyStorage)).toContain(body.joinKey);
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
    seats: () => seats.size,
    loseResponse: () => {
      loseNext = true;
    },
  };
}

describe("加入冪等鍵", () => {
  test("回應遺失後重試：沿用同一把鍵，只配一席", async () => {
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
    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]).toBe(server.sent[0]);
    expect(joinKeySchema.safeParse(server.sent[0]).success).toBe(true);
    // 身份存好後刪除鍵；下一次加入是新的一次。
    expect(localStorage.getItem(keyStorage)).toBeNull();
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
    expect(server.sent[1]).toBe(server.sent[0]);
    expect(storage.roomToken.get(ROOM)).toBeTruthy();
  });

  test("超過期限的鍵不再使用，改產生新的", async () => {
    const server = idempotentServer();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    server.loseResponse();
    await expect(joinKeepingIdentity(CODE, "朋友")).rejects.toBeDefined();
    vi.setSystemTime(1_000_000 + JOIN_KEY_TTL_MS);
    await joinKeepingIdentity(CODE, "朋友");
    expect(server.sent[1]).not.toBe(server.sent[0]);
  });

  test("成功加入後再加入另一房：每次按加入都是新的鍵", async () => {
    const server = idempotentServer();
    await joinKeepingIdentity(CODE, "朋友");
    roomToken.clear(ROOM);
    await joinKeepingIdentity(CODE, "朋友");
    expect(server.sent[1]).not.toBe(server.sent[0]);
  });
});
