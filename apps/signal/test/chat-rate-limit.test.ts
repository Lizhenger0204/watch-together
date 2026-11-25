import { describe, expect, test } from "vitest";
import { ChatRateLimiter } from "../src/signaling/chat-rate-limit";

describe("ChatRateLimiter", () => {
  test("時間窗內超過上限會被擋下，過期後恢復", () => {
    const limiter = new ChatRateLimiter({ limit: 5, windowMs: 10_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(limiter.allow("m1", t0 + i * 500)).toBe(true);
    }
    expect(limiter.allow("m1", t0 + 3_000)).toBe(false);
    // 第一則（t0）滿 10 秒過期後，立刻釋出一個名額。
    expect(limiter.allow("m1", t0 + 10_000)).toBe(true);
    expect(limiter.allow("m1", t0 + 10_000)).toBe(false);
  });

  test("不同成員分開計算，forget 會清除該成員紀錄", () => {
    const limiter = new ChatRateLimiter({ limit: 2, windowMs: 10_000 });
    expect(limiter.allow("m1", 100)).toBe(true);
    expect(limiter.allow("m1", 200)).toBe(true);
    expect(limiter.allow("m1", 300)).toBe(false);
    expect(limiter.allow("m2", 300)).toBe(true);

    limiter.forget("m1");
    expect(limiter.allow("m1", 400)).toBe(true);
  });
});
