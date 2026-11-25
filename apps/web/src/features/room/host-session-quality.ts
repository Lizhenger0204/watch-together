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
 * - 最後一筆被伺服器接受後，要等「它自己的畫質廣播」才清掉 `pending`。同一條 WebSocket 上伺服器
 *   依序處理 `room:update`、每筆先 ack 再廣播一次 `room:updated`，所以送出的請求依序排隊（`inflight`），
 *   收到的廣播只在畫質等於隊首時才算確認、並出列；隊列空了且最後一筆已 ack，才清掉 `pending`。
 *   鎖房、換邀請碼、換模式等其他 `room:update` 的廣播畫質不等於隊首，不會被誤當成畫質確認，
 *   也不會留下任何累計值；中間的舊廣播同樣不會把畫面拉回去。
 *   萬一廣播一直沒來（遺失），過 `QUALITY_BROADCAST_GRACE_MS` 後放棄等待並改回房間的畫質。
 * - 被拒絕或逾時的請求退出隊列（不會有它的廣播）；若它是最後一筆，立刻清掉 `pending`，畫面回到
 *   房間真實的畫質；更早的請求結果不改變狀態。
 * - 重新驗證（snapshot）或連線結束呼叫 `invalidate()`，之前送出的請求全部作廢。
 */
type Entry = { seq: number; quality: Quality };
type Latest = Entry & { acked: boolean };

export class QualityRequests {
  private seq = 0;
  /** 序號小於等於這個值的回應一律忽略。 */
  private floor = 0;
  private latest: Latest | null = null;
  private timer: unknown = null;
  /** 已送出、等著各自畫質廣播的請求（依送出順序）。 */
  private inflight: Entry[] = [];

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
    this.inflight.push({ seq, quality });
    this.setLatest({ seq, quality, acked: false });
    this.hooks.send(quality).then(
      () => {
        if (seq <= this.floor || this.latest?.seq !== seq) return;
        this.latest.acked = true;
        if (this.inflight.length === 0) {
          this.setLatest(null);
          return;
        }
        this.timer = this.hooks.timers.setTimeout(() => {
          this.timer = null;
          if (this.latest?.seq !== seq) return;
          this.inflight = [];
          this.setLatest(null);
        }, QUALITY_BROADCAST_GRACE_MS);
      },
      (error: unknown) => {
        if (seq <= this.floor) return;
        this.inflight = this.inflight.filter((entry) => entry.seq !== seq);
        if (this.latest?.seq !== seq) return;
        this.setLatest(null);
        this.hooks.rejected(error);
      },
    );
  }

  /** 收到 room:updated：畫質等於隊首才算那筆請求的廣播；隊列清空且最後一筆已 ack 就清掉 pending。 */
  observe(quality: Quality): void {
    const head = this.inflight[0];
    if (!head || !sameQuality(head.quality, quality)) return;
    this.inflight.shift();
    if (this.inflight.length === 0 && this.latest?.acked) this.setLatest(null);
  }

  /** 讓所有已送出的請求作廢（重新驗證、連線結束、銷毀）。 */
  invalidate(): void {
    this.floor = this.seq;
    this.inflight = [];
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
