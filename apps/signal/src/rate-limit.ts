import type { RateLimiter } from "./services";

/** POST /api/rooms/join：每個 IP 每分鐘 10 次（room-and-invite.md）。 */
export const JOIN_RATE_LIMIT = { limit: 10, periodMs: 60_000 } as const;

/**
 * 記憶體固定時間窗限流。只在單一行程（Workers isolate 或 Node 行程）內計數，
 * 用在 runtime 沒有提供限流服務、或限流服務出錯時的後備。
 */
export function createMemoryRateLimiter(options: {
  limit: number;
  periodMs: number;
  maxKeys?: number;
  now?: () => number;
}): RateLimiter {
  const { limit, periodMs, maxKeys = 10_000, now = Date.now } = options;
  const windows = new Map<string, { start: number; count: number }>();

  function prune(time: number) {
    for (const [key, window] of windows) {
      if (time - window.start >= periodMs) windows.delete(key);
    }
  }

  return {
    async allow(key) {
      const time = now();
      let window = windows.get(key);
      if (!window || time - window.start >= periodMs) {
        if (!window && windows.size >= maxKeys) prune(time);
        // 仍然太多 key（大量不同 IP）：寧可擋下新來的，不讓記憶體無限成長。
        if (!window && windows.size >= maxKeys) return false;
        window = { start: time, count: 0 };
        windows.set(key, window);
      }
      window.count += 1;
      return window.count <= limit;
    },
  };
}
