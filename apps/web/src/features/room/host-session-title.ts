/**
 * 直播中的片名更新（stream:status { live: true, title }）。
 *
 * 每筆請求配發遞增序號，只有最新一筆的成功或失敗會改變「待確認」狀態與錯誤顯示：
 * `B → C → B` 時第一個 B 晚到的拒絕不會清掉最後一個 B。
 * 停播、拆掉傳輸或重新驗證時呼叫 `invalidate()`，之前送出的請求全部作廢，
 * 停播後才回來的舊片名拒絕不再顯示錯誤。
 */
export class TitleSync {
  /** 伺服器目前的片名（snapshot、廣播、開播或片名更新的 ack）。 */
  server: string | null = null;
  private seq = 0;
  /** 序號小於等於這個值的回應一律忽略。 */
  private floor = 0;
  /** 已確認的最大序號（只用來避免舊 ack 蓋過新 ack 的片名）。 */
  private acked = 0;
  /** 最新一筆還沒確認的片名請求。片名可以是 null（空白片名），所以用物件包起來。 */
  private pending: { seq: number; title: string | null } | null = null;

  constructor(
    private readonly hooks: {
      send(title: string | null): Promise<void>;
      confirmed(): void;
      rejected(error: unknown): void;
    },
  ) {}

  /** 讓所有已送出的片名請求作廢（之後的 ack／拒絕都不改狀態）。 */
  invalidate(): void {
    this.floor = this.seq;
    this.pending = null;
  }

  /** 已送過同一個、或伺服器已是同一個且沒有未確認的變更，就不重送。 */
  update(title: string | null): void {
    if (this.pending ? title === this.pending.title : title === this.server) {
      return;
    }
    const seq = ++this.seq;
    this.pending = { seq, title };
    this.hooks.send(title).then(
      () => {
        if (seq <= this.floor) return;
        if (seq > this.acked) {
          this.acked = seq;
          this.server = title;
        }
        if (this.pending?.seq !== seq) return;
        this.pending = null;
        this.hooks.confirmed();
      },
      (error: unknown) => {
        if (seq <= this.floor || this.pending?.seq !== seq) return;
        this.pending = null;
        this.hooks.rejected(error);
      },
    );
  }
}
