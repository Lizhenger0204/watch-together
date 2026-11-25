/**
 * 聊天室每位成員的滑動時間窗限流（純記憶體、不依賴 Workers API）。
 * 接收 `now` 參數，方便單元測試使用假時間，不依賴真實時鐘。
 */
export class ChatRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly records = new Map<string, number[]>();

  constructor(options: { limit: number; windowMs: number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
  }

  allow(memberId: string, now: number): boolean {
    const existing = this.records.get(memberId);
    const active = existing
      ? existing.filter((timestamp) => now - timestamp < this.windowMs)
      : [];
    if (active.length >= this.limit) {
      this.records.set(memberId, active);
      return false;
    }
    active.push(now);
    this.records.set(memberId, active);
    if (this.records.size > 32) this.prune(now);
    return true;
  }

  forget(memberId: string): void {
    this.records.delete(memberId);
  }

  private prune(now: number): void {
    for (const [id, timestamps] of this.records) {
      const active = timestamps.filter((t) => now - t < this.windowMs);
      if (active.length === 0) this.records.delete(id);
      else this.records.set(id, active);
    }
  }
}
