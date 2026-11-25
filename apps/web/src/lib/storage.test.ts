import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  liveIntent,
  pendingJoinKey,
  resetMemoryStorage,
  roomInviteCode,
  roomToken,
} from "./storage";

const ROOM = "0b6f6e2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

class BrokenStorage extends MemoryStorage {
  override setItem(): never {
    throw new DOMException("quota", "QuotaExceededError");
  }
  override getItem(): never {
    throw new DOMException("denied", "SecurityError");
  }
}

beforeEach(() => resetMemoryStorage());
afterEach(() => vi.unstubAllGlobals());

describe("roomToken", () => {
  test("localStorage 寫不進去時，同一分頁仍讀得到 token", () => {
    vi.stubGlobal("localStorage", new BrokenStorage());
    expect(roomToken.set(ROOM, "token")).toBe(false);
    expect(roomToken.get(ROOM)).toBe("token");
  });

  test("寫得進去時也存到 localStorage（重新整理後恢復）", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(roomToken.set(ROOM, "token")).toBe(true);
    expect(storage.getItem(`room:${ROOM}:token`)).toBe("token");
    resetMemoryStorage(); // 模擬重新整理
    expect(roomToken.get(ROOM)).toBe("token");
  });

  test("clear 後即使 localStorage 刪不掉，也不會讀回舊值", () => {
    const storage = new MemoryStorage();
    storage.setItem(`room:${ROOM}:token`, "old");
    storage.removeItem = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", storage);
    roomToken.clear(ROOM);
    expect(roomToken.get(ROOM)).toBeNull();
    const renewed = crypto.randomUUID();
    storage.setItem(`room:${ROOM}:token`, renewed);
    expect(roomToken.get(ROOM)).toBe(renewed);
  });

  test("本分頁寫入失敗時保留記憶體身份；其他分頁寫入新值也不覆蓋", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const key = `room:${ROOM}:token`;
    const [local, previous, updated] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ] as const;
    storage.setItem(key, previous);
    const denied = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(roomToken.set(ROOM, local)).toBe(false);
    expect(roomToken.get(ROOM)).toBe(local);
    expect(roomToken.persisted(ROOM)).toBe(false);
    denied.mockRestore();
    // 其他分頁寫入新值：本分頁只在記憶體的有效身份不可被蓋掉，仍提示未保存。
    storage.setItem(key, updated);
    expect(roomToken.get(ROOM)).toBe(local);
    expect(roomToken.persisted(ROOM)).toBe(false);
    storage.removeItem(key);
    expect(roomToken.get(ROOM)).toBe(local);
    // 本分頁的身份確認失效後才接手共用值。
    storage.setItem(key, updated);
    roomToken.clearIfCurrent(ROOM, local);
    expect(roomToken.get(ROOM)).toBe(updated);
  });

  test("建房時第一次寫入失敗，其他分頁以收看者加入後，本分頁仍是房主", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const key = `room:${ROOM}:token`;
    const host = crypto.randomUUID();
    const viewer = crypto.randomUUID();
    const denied = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(roomToken.set(ROOM, host)).toBe(false);
    denied.mockRestore();
    storage.setItem(key, viewer); // 另一分頁加入同一房並存好收看者憑證
    expect(roomToken.persisted(ROOM)).toBe(false); // 警告不可因此消失
    expect(roomToken.get(ROOM)).toBe(host);
  });

  test("本分頁已清除身份時，採用其他分頁之後寫入的新憑證", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const key = `room:${ROOM}:token`;
    roomToken.set(ROOM, crypto.randomUUID());
    roomToken.clear(ROOM);
    const fresh = crypto.randomUUID();
    storage.setItem(key, fresh);
    expect(roomToken.get(ROOM)).toBe(fresh);
  });

  test("clear 一併清掉邀請碼對照與開播意圖", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    roomToken.set(ROOM, "token");
    roomInviteCode.set(ROOM, "ABCDEFGH");
    liveIntent.set(ROOM, true);
    roomToken.clear(ROOM);
    expect(roomInviteCode.findRoom("ABCDEFGH")).toBeNull();
    expect(liveIntent.get(ROOM)).toBe(false);
  });

  test("只在記憶體的憑證驗證失敗時，恢復共用儲存中的另一份憑證", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const shared = crypto.randomUUID();
    const local = crypto.randomUUID();
    roomToken.set(ROOM, shared);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    roomToken.set(ROOM, local);
    roomToken.clearIfCurrent(ROOM, local);
    expect(storage.getItem(`room:${ROOM}:token`)).toBe(shared);
    expect(roomToken.get(ROOM)).toBe(shared);
  });
});

describe("roomToken.rooms", () => {
  test("列出記憶體與 localStorage 中持有憑證的房號，不含已清除的", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const [stored, memoryOnly, cleared] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ] as const;
    storage.setItem(`room:${stored}:token`, "a");
    const denied = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    roomToken.set(memoryOnly, "b"); // 例如建房時存不進去的房主憑證
    denied.mockRestore();
    roomToken.set(cleared, "c");
    roomToken.clear(cleared);
    expect(roomToken.rooms().sort()).toEqual([stored, memoryOnly].sort());
  });

  test("沒有 localStorage 時也列出本分頁記憶體中的房號", () => {
    vi.stubGlobal("localStorage", new BrokenStorage());
    roomToken.set(ROOM, "token");
    expect(roomToken.rooms()).toEqual([ROOM]);
  });
});

describe("liveIntent", () => {
  test("重新整理後保留本分頁的開播意圖", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    liveIntent.set(ROOM, true);
    resetMemoryStorage();
    expect(liveIntent.get(ROOM)).toBe(true);
  });

  test("另一分頁明確停播後，本分頁保存的意圖失效；之後重新設定才有效", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    const tab = new MemoryStorage();
    vi.stubGlobal("sessionStorage", tab);
    liveIntent.set(ROOM, true);

    vi.resetModules();
    const other = await import("./storage");
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    other.liveIntent.set(ROOM, true);
    other.liveIntent.stopEverywhere(ROOM);
    expect(other.liveIntent.get(ROOM)).toBe(false);

    vi.stubGlobal("sessionStorage", tab);
    expect(liveIntent.get(ROOM)).toBe(false);
    resetMemoryStorage(); // 重新整理也一樣
    expect(liveIntent.get(ROOM)).toBe(false);
    liveIntent.set(ROOM, true);
    expect(liveIntent.get(ROOM)).toBe(true);
  });
});

describe("roomInviteCode", () => {
  test("重新整理後仍能從 localStorage 找回邀請碼對應的房間", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    roomInviteCode.set(ROOM, "ABCDEFGH");
    resetMemoryStorage();
    expect(roomInviteCode.findRoom("ABCDEFGH")).toBe(ROOM);
    expect(roomInviteCode.findRoom("ZZZZZZZZ")).toBeNull();
  });

  test("斷線分頁晚收到 v1 時，sync 採用另一分頁已保存的 v2 而不倒退覆蓋共用儲存", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    // 乙頁已換到 v2 並寫入共用儲存。
    expect(roomInviteCode.sync(ROOM, "CCCCCCCC", 2)).toEqual({
      inviteCode: "CCCCCCCC",
      version: 2,
    });
    expect(roomInviteCode.findRoom("CCCCCCCC")).toBe(ROOM);

    // 模擬甲頁（只有舊記憶體狀態 v0）在斷線後晚收到 v1 REST 回應。
    resetMemoryStorage();
    expect(roomInviteCode.sync(ROOM, "BBBBBBBB", 1)).toEqual({
      inviteCode: "CCCCCCCC",
      version: 2,
    });
    expect(storage.getItem(`room:${ROOM}:invite`)).toBe("CCCCCCCC:2");
    expect(roomInviteCode.findRoom("CCCCCCCC")).toBe(ROOM);
    expect(roomInviteCode.findRoom("BBBBBBBB")).toBeNull();

    // 同碼無版本寫入會保留版本號。
    roomInviteCode.set(ROOM, "CCCCCCCC");
    expect(storage.getItem(`room:${ROOM}:invite`)).toBe("CCCCCCCC:2");
  });

  test("subscribe 收到同源分頁的 storage 換碼事件時回報新碼與版本", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    const listeners = new Set<(event: Event) => void>();
    vi.stubGlobal("addEventListener", (_type: string, fn: (e: Event) => void) =>
      listeners.add(fn),
    );
    vi.stubGlobal(
      "removeEventListener",
      (_type: string, fn: (e: Event) => void) => listeners.delete(fn),
    );
    const seen: Array<{ inviteCode: string; version: number }> = [];
    const off = roomInviteCode.subscribe(ROOM, (latest) => seen.push(latest));
    const event = {
      key: `room:${ROOM}:invite`,
      newValue: "CCCCCCCC:2",
    } as unknown as Event;
    for (const fn of listeners) fn(event);
    expect(seen).toEqual([{ inviteCode: "CCCCCCCC", version: 2 }]);
    off();
    expect(listeners.size).toBe(0);
  });
});

describe("pendingJoinKey", () => {
  const CODE = "ABCDEFGH";
  const OTHER_CODE = "XYZW2345";

  test("寫入失敗後，另一分頁寫入的新鍵不會被舊分頁的 clearIfCurrent 誤刪", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const localKey = crypto.randomUUID();
    const otherTabKey = crypto.randomUUID();

    const denied = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(pendingJoinKey.set(CODE, localKey, 1000)).toBe(false);
    expect(pendingJoinKey.persisted(CODE, localKey)).toBe(false);
    expect(pendingJoinKey.get(CODE, 60_000, 1000) === localKey).toBe(true);
    denied.mockRestore();

    // 另一分頁成功寫入自己的待完成鍵。
    storage.setItem(`join:${CODE}:key`, `2000:${otherTabKey}`);

    // 舊分頁清理自己那把：只清記憶體，必須保留另一分頁在 localStorage 的值。
    pendingJoinKey.clearIfCurrent(CODE, localKey);
    expect(storage.getItem(`join:${CODE}:key`) === `2000:${otherTabKey}`).toBe(
      true,
    );
    expect(pendingJoinKey.get(CODE, 60_000, 2000) === otherTabKey).toBe(true);
  });

  test("正常寫入後若另一分頁已清除，本分頁不會讀回舊鍵", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const key = crypto.randomUUID();
    expect(pendingJoinKey.set(CODE, key, 1000)).toBe(true);
    expect(pendingJoinKey.persisted(CODE, key)).toBe(true);
    storage.removeItem(`join:${CODE}:key`);
    expect(pendingJoinKey.get(CODE, 60_000, 1000) === null).toBe(true);
  });

  test("逾期讀取會即時刪除儲存項；prune 會清掉其他邀請碼的逾期鍵", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const expiredA = crypto.randomUUID();
    const expiredB = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    pendingJoinKey.set(CODE, expiredA, 1000);
    pendingJoinKey.set(OTHER_CODE, expiredB, 1000);
    pendingJoinKey.set("MNPQ6789", fresh, 50_000);

    expect(pendingJoinKey.get(CODE, 10_000, 11_000) === null).toBe(true);
    expect(storage.getItem(`join:${CODE}:key`) === null).toBe(true);

    pendingJoinKey.prune(10_000, 55_000);
    expect(storage.getItem(`join:${OTHER_CODE}:key`) === null).toBe(true);
    expect(pendingJoinKey.get("MNPQ6789", 10_000, 55_000) === fresh).toBe(true);
  });

  test("removeItem 暫時失敗後：隱藏舊鍵、不擋他頁新鍵，恢復後 prune() 會補刪舊值", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const oldKey = crypto.randomUUID();
    const newKey = crypto.randomUUID();
    pendingJoinKey.set(CODE, oldKey, 1000);
    const denied = vi.spyOn(storage, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    pendingJoinKey.clearIfCurrent(CODE, oldKey);
    expect(pendingJoinKey.get(CODE, 60_000, 1000) === null).toBe(true);
    // 持久儲存裡還留著舊值；恢復儲存並呼叫 prune() 後必須補刪乾淨。
    expect(storage.getItem(`join:${CODE}:key`) !== null).toBe(true);
    denied.mockRestore();
    pendingJoinKey.prune(60_000, 100_000);
    expect(storage.getItem(`join:${CODE}:key`) === null).toBe(true);

    // 刪除失敗後若有另一分頁寫入新鍵，prune() 淘汰過時墓碑且保留未逾期的新鍵。
    pendingJoinKey.set(OTHER_CODE, oldKey, 1000);
    const denied2 = vi.spyOn(storage, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    pendingJoinKey.clearIfCurrent(OTHER_CODE, oldKey);
    denied2.mockRestore();
    storage.setItem(`join:${OTHER_CODE}:key`, `2000:${newKey}`);
    pendingJoinKey.prune(60_000, 3000);
    expect(storage.getItem(`join:${OTHER_CODE}:key`) === `2000:${newKey}`).toBe(
      true,
    );
    expect(pendingJoinKey.get(OTHER_CODE, 60_000, 3000) === newKey).toBe(true);
  });
});
