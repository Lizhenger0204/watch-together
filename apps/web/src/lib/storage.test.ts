import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  liveIntent,
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

describe("roomInviteCode", () => {
  test("重新整理後仍能從 localStorage 找回邀請碼對應的房間", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    roomInviteCode.set(ROOM, "ABCDEFGH");
    resetMemoryStorage();
    expect(roomInviteCode.findRoom("ABCDEFGH")).toBe(ROOM);
    expect(roomInviteCode.findRoom("ZZZZZZZZ")).toBeNull();
  });
});
