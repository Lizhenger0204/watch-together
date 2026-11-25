// 同源分頁之間的互斥鎖：優先用 Web Locks。瀏覽器沒有 Web Locks（例如舊版瀏覽器、
// 非安全來源的 http 區網網址）時，改用 IndexedDB 的 readwrite 交易登記租約。
// 同一個 object store 的 readwrite 交易在同源分頁之間依序執行，「讀取租約 → 沒人持有就寫入」
// 在同一筆交易內完成，不會兩個分頁同時拿到。持有者關掉分頁時，租約逾時後自動釋放。
// 兩者都不能用（例如 IndexedDB 被封鎖）就直接執行，退回只靠分頁內的協調。

const DB_NAME = "tab-locks";
const STORE = "leases";
/** 持有者每隔 RENEW_MS 續約；超過 LEASE_MS 沒續約（分頁已關）就視為釋放。 */
export const LEASE_MS = 10_000;
const RENEW_MS = 3_000;
/** 等待別的分頁釋放時，每隔多久再試一次。 */
export const POLL_MS = 100;

type Lease = { owner: string; expires: number };

export type TabLockDeps = {
  locks?: LockManager;
  indexedDB?: IDBFactory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(factory: IDBFactory) {
  const req = factory.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return request(req);
}

/** 在同一筆 readwrite 交易內：租約不存在、已逾時或本來就是自己的，才寫入新租約。 */
function claim(db: IDBDatabase, name: string, owner: string, now: number) {
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let claimed = false;
    const get = store.get(name);
    get.onsuccess = () => {
      const lease = get.result as Lease | undefined;
      if (lease && lease.owner !== owner && lease.expires > now) return;
      claimed = true;
      store.put({ owner, expires: now + LEASE_MS } satisfies Lease, name);
    };
    tx.oncomplete = () => resolve(claimed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function release(db: IDBDatabase, name: string, owner: string) {
  return new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const get = store.get(name);
    get.onsuccess = () => {
      if ((get.result as Lease | undefined)?.owner === owner)
        store.delete(name);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function withLease<T>(
  factory: IDBFactory,
  name: string,
  fn: () => Promise<T>,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let db: IDBDatabase;
  try {
    db = await openDb(factory);
  } catch {
    return fn();
  }
  const owner = `${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    for (;;) {
      if (await claim(db, name, owner, now())) break;
      await sleep(POLL_MS);
    }
  } catch {
    db.close();
    return fn();
  }
  const renew = setInterval(() => {
    claim(db, name, owner, now()).catch(() => {});
  }, RENEW_MS);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await release(db, name, owner);
    db.close();
  }
}

/** 同源分頁之間依序執行 fn（同一分頁內也依序）。 */
export function withTabLock<T>(
  name: string,
  fn: () => Promise<T>,
  deps: TabLockDeps = {},
): Promise<T> {
  const locks = "locks" in deps ? deps.locks : globalThis.navigator?.locks;
  if (locks) return locks.request(name, fn);
  let factory: IDBFactory | undefined;
  try {
    factory = "indexedDB" in deps ? deps.indexedDB : globalThis.indexedDB;
  } catch {
    factory = undefined;
  }
  if (!factory) return fn();
  return withLease(
    factory,
    name,
    fn,
    deps.now ?? Date.now,
    deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  );
}
