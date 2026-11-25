import { describe, expect, test, vi } from "vitest";
import { LEASE_MS, withTabLock, type TabLockDeps } from "./tab-lock";
import { FakeIndexedDB, asFactory } from "./tab-lock.fixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const fastSleep = () => new Promise<void>((r) => setTimeout(r, 1));

function idbDeps(fake: FakeIndexedDB, now = () => 0): TabLockDeps {
  return {
    locks: undefined,
    indexedDB: asFactory(fake),
    now,
    sleep: fastSleep,
  };
}

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
    const log: string[] = [];
    const first = deferred();
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
    const b = withTabLock(
      "room:join",
      async () => {
        log.push("b start");
        return "b";
      },
      idbDeps(fake),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(["a start"]);
    first.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(log).toEqual(["a start", "a end", "b start"]);
    expect(fake.data.size).toBe(0); // 都釋放了
  });

  test("持有者的分頁關掉（租約逾時）後，其他分頁可以接手", async () => {
    const fake = new FakeIndexedDB();
    fake.data.set("room:join", { owner: "closed-tab", expires: LEASE_MS });
    let now = 0;
    const run = withTabLock(
      "room:join",
      async () => "ok",
      idbDeps(fake, () => now),
    );
    await new Promise((r) => setTimeout(r, 10));
    now = LEASE_MS + 1;
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
