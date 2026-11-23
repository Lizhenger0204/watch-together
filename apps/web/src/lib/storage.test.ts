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
