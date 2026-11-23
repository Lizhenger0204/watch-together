import { expect, test } from "vitest";
import { createMemoryRateLimiter } from "../src/rate-limit";

test("同一個 key 每個時間窗只放行 limit 次，時間窗過後重新計算", async () => {
  let now = 0;
  const limiter = createMemoryRateLimiter({
    limit: 2,
    periodMs: 1000,
    now: () => now,
  });
  expect(await limiter.allow("a")).toBe(true);
  expect(await limiter.allow("a")).toBe(true);
  expect(await limiter.allow("a")).toBe(false);
  expect(await limiter.allow("b")).toBe(true);
  now = 1000;
  expect(await limiter.allow("a")).toBe(true);
});

test("key 太多時先清掉過期的；仍然太多就擋下新 key", async () => {
  let now = 0;
  const limiter = createMemoryRateLimiter({
    limit: 5,
    periodMs: 1000,
    maxKeys: 2,
    now: () => now,
  });
  expect(await limiter.allow("a")).toBe(true);
  expect(await limiter.allow("b")).toBe(true);
  expect(await limiter.allow("c")).toBe(false);
  expect(await limiter.allow("a")).toBe(true); // 既有 key 不受影響
  now = 1000;
  expect(await limiter.allow("c")).toBe(true);
});
