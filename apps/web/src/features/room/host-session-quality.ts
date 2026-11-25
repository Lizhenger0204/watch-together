import { sameQuality, type Quality } from "@project/shared";
import type { SessionTimers } from "./viewer-session";

/** 房間已接受最後一次選擇、卻一直沒收到對應廣播時，最多等這麼久就改回房間的畫質。 */
export const QUALITY_BROADCAST_GRACE_MS = 10_000;

/**
 * 房主的畫質調整請求（streaming.md §2）。
 *
 * 連續調整時 `room:update` 與 `room:updated` 廣播各自延遲，廣播的順序和內容可能落後於
 * 房主「最後一次選擇」。所以由這裡追蹤最後的選擇（`pending`）：
 * - 新請求與「最後的選擇」比較（不是與廣播來的舊值比較），`8→10→15→8` 最後的 8 一定送出。
 * - 最後一筆被伺服器接受後，要等廣播追上它才清掉 `pending`；中間的舊廣播不會把畫面拉回去。
 *   伺服器對每筆被接受的 `room:update`（先 ack、再廣播）各送一次 `room:updated`，
 *   所以「收到的廣播數 ≥ 被接受的請求數」就代表追上了；只比較畫質值會被「舊廣播剛好等於
 *   最後的選擇」騙過。萬一廣播一直沒來（遺失），過 `QUALITY_BROADCAST_GRACE_MS` 後也改回房間的畫質。
 * - 最後一筆被拒絕或逾時，立刻清掉 `pending`，畫面回到房間真實的畫質；更早的請求結果不改變狀態。
 * - 重新驗證（snapshot）或連線結束呼叫 `invalidate()`，之前送出的請求全部作廢。
 */
type Latest = { seq: number; quality: Quality; acked: boolean };

export class QualityRequests {
  private seq = 0;
  /** 序號小於等於這個值的回應一律忽略。 */
  private floor = 0;
  private latest: Latest | null = null;
  private timer: unknown = null;
  /** 自上次作廢以來，被伺服器接受的請求數與收到的 room:updated 數。 */
  private accepted = 0;
  private received = 0;

  constructor(
    private readonly hooks: {
      send(quality: Quality): Promise<void>;
      /** 房間目前（最近一次廣播或 snapshot）的畫質。 */
      current(): Quality;
      /** `pending` 改變了。 */
      changed(): void;
      rejected(error: unknown): void;
      timers: SessionTimers;
    },
  ) {}

  /** 最後一次選擇（還沒被房間廣播追上），沒有時為 null。 */
  get pending(): Quality | null {
    return this.latest?.quality ?? null;
  }

  /** 要不要送：與「最後的選擇」或房間目前的畫質相同就不送。 */
  request(quality: Quality): void {
    if (sameQuality(quality, this.latest?.quality ?? this.hooks.current()))
      return;
    const seq = ++this.seq;
    this.setLatest({ seq, quality, acked: false });
    this.hooks.send(quality).then(
      () => {
        if (seq <= this.floor) return;
        this.accepted += 1;
        if (this.latest?.seq !== seq) return;
        this.latest.acked = true;
        if (this.caughtUp()) {
          this.setLatest(null);
          return;
        }
        this.timer = this.hooks.timers.setTimeout(() => {
          this.timer = null;
          if (this.latest?.seq === seq) this.setLatest(null);
        }, QUALITY_BROADCAST_GRACE_MS);
      },
      (error: unknown) => {
        if (seq <= this.floor || this.latest?.seq !== seq) return;
        this.setLatest(null);
        this.hooks.rejected(error);
      },
    );
  }

  /** 收到 room:updated：最後一筆已被接受且廣播追上了，就清掉 pending。 */
  observe(): void {
    this.received += 1;
    if (this.caughtUp()) this.setLatest(null);
  }

  private caughtUp(): boolean {
    return !!this.latest?.acked && this.received >= this.accepted;
  }

  /** 讓所有已送出的請求作廢（重新驗證、連線結束、銷毀）。 */
  invalidate(): void {
    this.floor = this.seq;
    this.accepted = 0;
    this.received = 0;
    if (this.latest) this.setLatest(null);
    else this.clearTimer();
  }

  private clearTimer() {
    this.hooks.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private setLatest(next: Latest | null) {
    this.clearTimer();
    this.latest = next;
    this.hooks.changed();
  }
}
