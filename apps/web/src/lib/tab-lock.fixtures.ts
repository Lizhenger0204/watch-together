// tab-lock 測試用的 IndexedDB 替身：只實作 tab-lock.ts 用到的部分。
// 同一個替身裡的交易依建立順序一筆一筆執行（和瀏覽器同一個 object store 的 readwrite 交易一樣），
// 交易內的請求依序完成，請求的 onsuccess 裡再發的請求也算同一筆交易。

type Handler = (() => void) | null;
type FakeRequest = {
  result: unknown;
  error: null;
  onsuccess: Handler;
  onerror: Handler;
  onupgradeneeded?: Handler;
};
type FakeTransaction = {
  ops: (() => void)[];
  error: null;
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
  objectStore(): unknown;
};

export class FakeIndexedDB {
  readonly data = new Map<string, unknown>();
  /** 設為 true 時 open() 失敗（例如瀏覽器封鎖 IndexedDB）。 */
  failOpen = false;
  private readonly putWaiters: {
    match: (key: string, value: unknown) => boolean;
    resolve: () => void;
  }[] = [];

  /** 等到有交易寫入符合條件的值（例如「某分頁已取得租約」），不必靠真實時間輪詢。 */
  waitForPut(match: (key: string, value: unknown) => boolean) {
    return new Promise<void>((resolve) =>
      this.putWaiters.push({ match, resolve }),
    );
  }

  private notifyPut(key: string, value: unknown) {
    for (const waiter of [...this.putWaiters]) {
      if (!waiter.match(key, value)) continue;
      this.putWaiters.splice(this.putWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }
  private readonly queue: FakeTransaction[] = [];
  private running = false;

  open(): IDBOpenDBRequest {
    const req: FakeRequest = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    const db = {
      createObjectStore: () => undefined,
      close: () => undefined,
      transaction: () => this.begin(),
    };
    void Promise.resolve().then(() => {
      if (this.failOpen) {
        req.onerror?.();
        return;
      }
      req.result = db;
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req as unknown as IDBOpenDBRequest;
  }

  private begin() {
    const op = (fn: () => unknown) => {
      const req: FakeRequest = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      tx.ops.push(() => {
        req.result = fn();
        req.onsuccess?.();
      });
      return req;
    };
    const store = {
      get: (key: string) => op(() => this.data.get(key)),
      put: (value: unknown, key: string) =>
        op(() => {
          this.data.set(key, value);
          this.notifyPut(key, value);
        }),
      delete: (key: string) => op(() => void this.data.delete(key)),
    };
    const tx: FakeTransaction = {
      ops: [],
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => store,
    };
    this.queue.push(tx);
    void this.pump();
    return tx;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const tx = this.queue[0]!;
      // 讓呼叫端先掛上 handler、送出第一個請求。
      await Promise.resolve();
      while (tx.ops.length) {
        tx.ops.shift()!();
        await Promise.resolve();
      }
      this.queue.shift();
      tx.oncomplete?.();
    }
    this.running = false;
  }
}

export const asFactory = (fake: FakeIndexedDB) => fake as unknown as IDBFactory;
