import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LEASE_MS, POLL_MS, withTabLock, type TabLockDeps } from "./tab-lock";
import { FakeIndexedDB, asFactory } from "./tab-lock.fixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// 一律用假時鐘：等「已取得租約」或「開始等待」的事件，再推進時間，不靠真實的 setTimeout。
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** 預設的 sleep（假時鐘上的 setTimeout），另外通知「有分頁開始等待」。 */
function watchedSleep() {
  const waiters: (() => void)[] = [];
  return {
    sleep(ms: number) {
      waiters.splice(0).forEach((resolve) => resolve());
      return new Promise<void>((r) => setTimeout(r, ms));
    },
    nextSleep: () => new Promise<void>((r) => waiters.push(r)),
  };
}

function idbDeps(
  fake: FakeIndexedDB,
  sleep?: (ms: number) => Promise<void>,
): TabLockDeps {
  return { locks: undefined, indexedDB: asFactory(fake), sleep };
}

const claimedBy = (fake: FakeIndexedDB, other?: string) =>
  fake.waitForPut(
    (key, value) =>
      key === "room:join" && (value as { owner: string }).owner !== other,
  );

describe("withTabLock", () => {
  test("有 Web Locks 時交給 Web Locks", async () => {
    const request = vi.fn((_name: string, fn: () => Promise<number>) => fn());
    const locks = { request } as unknown as LockManager;
    await expect(
      withTabLock("room:join", async () => 1, { locks }),
    ).resolves.toBe(1);
    expect(request.mock.calls[0]?.[0]).toBe("room:join");
  });

  test("沒有 Web Locks：用 IndexedDB 租約，兩個分頁依序執行", async () => {
    const fake = new FakeIndexedDB();
    const waiting = watchedSleep();
    const log: string[] = [];
    const first = deferred();
    const aClaimed = claimedBy(fake);
    const a = withTabLock(
      "room:join",
      async () => {
        log.push("a start");
        await first.promise;
        log.push("a end");
        return "a";
      },
      idbDeps(fake),
    );
    await aClaimed;
    const bWaiting = waiting.nextSleep();
    const b = withTabLock(
      "room:join",
      async () => {
        log.push("b start");
        return "b";
      },
      idbDeps(fake, waiting.sleep),
    );
    await bWaiting;
    // 持有者續約：超過租約期限仍在執行，另一分頁也不能接手。
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
    expect(log).toEqual(["a start"]);
    first.resolve();
    await expect(a).resolves.toBe("a");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["a start", "a end", "b start"]);
    expect(fake.data.size).toBe(0); // 都釋放了
  });

  test("持有者的分頁關掉（租約逾時）後，其他分頁可以接手", async () => {
    const fake = new FakeIndexedDB();
    fake.data.set("room:join", { owner: "closed-tab", expires: LEASE_MS });
    const waiting = watchedSleep();
    const started = vi.fn(async () => "ok");
    const firstWait = waiting.nextSleep();
    const run = withTabLock("room:join", started, idbDeps(fake, waiting.sleep));
    await firstWait;
    await vi.advanceTimersByTimeAsync(LEASE_MS - POLL_MS);
    expect(started).not.toHaveBeenCalled(); // 到期點之前仍屬於關掉的分頁
    const claimed = claimedBy(fake, "closed-tab");
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    await claimed;
    await expect(run).resolves.toBe("ok");
  });

  test("執行失敗也會釋放租約", async () => {
    const fake = new FakeIndexedDB();
    await expect(
      withTabLock(
        "room:join",
        async () => {
          throw new Error("boom");
        },
        idbDeps(fake),
      ),
    ).rejects.toThrow("boom");
    expect(fake.data.size).toBe(0);
  });

  test("IndexedDB 打不開或不存在：直接執行", async () => {
    const fake = new FakeIndexedDB();
    fake.failOpen = true;
    await expect(
      withTabLock("room:join", async () => 1, idbDeps(fake)),
    ).resolves.toBe(1);
    await expect(
      withTabLock("room:join", async () => 2, {
        locks: undefined,
        indexedDB: undefined,
      }),
    ).resolves.toBe(2);
  });
});
