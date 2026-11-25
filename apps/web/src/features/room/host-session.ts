import type { Mode, Quality, ServerMessage } from "@project/shared";
import type { ConnectionState } from "../../lib/signal";
import {
  createHostTransport,
  type CreateHostTransport,
  type HostTransport,
  type TransportSignal,
} from "../transport";
import { HostSessionFlows } from "./host-session-flows";
import { TitleSync } from "./host-session-title";
import {
  KINDS,
  NO_TRACKS,
  browserTimers,
  disconnected,
  onlineViewers,
  readable,
  tracksOf,
} from "./host-session-types";
import type {
  HostPhase,
  HostSessionOptions,
  HostSessionView,
  HostSource,
  Op,
  Tracks,
} from "./host-session-types";
import { streamTitle } from "./live-intent";
import type { SessionTimers } from "./viewer-session";

// 房主的房間層（streaming.md §1、§6、§9「生命週期與誰協調」）：
// 依開播意圖、片源與伺服器狀態建立／銷毀 host transport，
// await start() 後才送 stream:status { live: true }；換片走 replaceTrack；
// 收看者消失或離線時 removePeer；直播中切模式照 §6「房主」1～4 步；
// 重新驗證（room:snapshot）時拆掉舊傳輸再依意圖重建；連線以 4000 等關閉時銷毀傳輸。
// 不依賴 React；SignalClient、傳輸工廠與計時器都可注入。
// 送請求、等 ack／廣播與建立傳輸在 host-session-base.ts，開播／停播／切模式流程在
// host-session-flows.ts，片名更新在 host-session-title.ts。
//
// 房主的 stream:status 一律由本類別送出（取代 RoomPage 原本的 useLiveIntent），不要兩套並存。

export class HostSession extends HostSessionFlows {
  private host = false;
  /** 已收到這條連線的 room:snapshot，且連線仍是 open。 */
  private connected = false;
  /** 連線以關閉碼結束（4000 等）：之後什麼都不送。 */
  protected closed = false;
  protected destroyed = false;
  protected intent: boolean;
  protected source: HostSource = { stream: null, status: "idle", title: "" };
  protected mode: Mode = "p2p";
  protected quality: Quality = "standard";
  /** 伺服器目前的直播狀態（snapshot、stream:status 廣播、自己 live:true 的 ack）。 */
  protected serverLive = false;
  protected readonly titles: TitleSync;
  private viewers = new Set<string>();
  protected transport: HostTransport | null = null;
  /** 最後一次交給傳輸的各 kind track。 */
  protected applied: Tracks = NO_TRACKS;
  /** 每次建立或拆掉傳輸、每次重新驗證就加一，讓晚到的回呼失效。 */
  protected generation = 0;
  protected signalHandler: Parameters<TransportSignal["onSignal"]>[0] | null =
    null;
  protected peerHandler:
    Parameters<TransportSignal["onPeerRequest"]>[0] | null = null;
  protected op: Op | null = null;
  protected readyGeneration: number | null = null;
  protected liveSends = 0;
  protected stopCovers = 0;
  /** 等停播確認時，收到 live:false 廣播就呼叫。 */
  protected stopWaiter: (() => void) | null = null;
  /** 切模式第 2 步：收到目標模式的 room:updated 就呼叫。 */
  protected modeWaiter: { mode: Mode; resolve: () => void } | null = null;
  /** modeWaiter 的等待廣播期限計時器。 */
  protected modeTimer: unknown = null;
  protected error: string | null = null;
  private view: HostSessionView;
  private readonly listeners = new Set<() => void>();
  protected readonly createTransport: CreateHostTransport;
  protected readonly options: HostSessionOptions;
  protected readonly timers: SessionTimers;

  constructor(options: HostSessionOptions) {
    super();
    this.options = options;
    this.timers = options.timers ?? browserTimers;
    this.intent = options.initialIntent;
    this.createTransport = options.createTransport ?? createHostTransport;
    this.titles = new TitleSync({
      send: (title) =>
        options.client.request({ type: "stream:status", live: true, title }),
      confirmed: () => this.publish(),
      rejected: (error) => this.showError(error),
    });
    this.view = { intent: this.intent, phase: this.phase(), error: null };
  }

  /** 在 SignalClient.start() 之前呼叫；回傳的函式解除監聽並 destroy()。 */
  attach(): () => void {
    const offMessage = this.options.client.onMessage((message) =>
      this.handleMessage(message),
    );
    const offState = this.options.client.onState((state) =>
      this.handleState(state),
    );
    return () => {
      offMessage();
      offState();
      this.destroy();
    };
  }

  getView = (): HostSessionView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 「開始直播」／「停止直播」。開播失敗會自動取消意圖（再按一次即重試）。 */
  setIntent(on: boolean): void {
    if (this.destroyed || this.intent === on) return;
    this.intent = on;
    this.options.onIntentChange?.(on);
    if (!on) this.options.onExplicitStop?.();
    if (on) this.error = null;
    this.reconcile();
    this.publish();
  }

  /**
   * 片源變動（換檔、檢查狀態、addtrack／removetrack）。同一個 stream 也可能重複傳入，
   * 每次都比對各 kind 目前的 track，有變才 replaceTrack。
   */
  setSource(source: HostSource): void {
    if (this.destroyed) return;
    this.source = source;
    this.applyTracks();
    this.reconcile();
    this.publish();
  }

  /** 切換傳送方式。直播中走 §6「先停再開」；否則直接送 room:update。 */
  setMode(mode: Mode): void {
    if (!this.usable() || mode === this.mode) return;
    // 開播、停播、切換進行中不接受（UI 依 phase 停用選項）。
    if (this.op) return;
    this.error = null;
    if (this.transport && this.serverLive) {
      void this.switchMode(mode, true);
      this.publish();
      return;
    }
    this.dropTransport();
    this.options.client
      .request({ type: "room:update", mode })
      .catch((error: unknown) => this.showError(error));
    this.publish();
  }

  /** 切換畫質：送 room:update，收到 room:updated 後對現有傳輸 setQuality。 */
  setQuality(quality: Quality): void {
    if (!this.usable() || quality === this.quality) return;
    this.error = null;
    this.options.client
      .request({ type: "room:update", quality })
      .catch((error: unknown) => this.showError(error));
    this.publish();
  }

  clearError(): void {
    this.error = null;
    this.publish();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.dropTransport();
    this.op = null;
    this.stopWaiter = null;
    this.clearModeWaiter();
    this.destroyed = true;
    this.listeners.clear();
  }

  // ── 伺服器事件 ─────────────────────────────────────────

  private handleState(state: ConnectionState) {
    if (this.destroyed || this.closed) return;
    if (state.status === "closed") {
      // 4000（另一分頁接手）、被踢、房間關閉、stop()：結束這次連線的傳輸（§6）。
      this.closed = true;
      this.connected = false;
      this.dropTransport();
      this.op = null;
      // 被取代的舊分頁之後重新整理，不可自動開播把接手的分頁擠掉。
      if (state.reason === "replaced") this.cancelIntent();
      this.publish();
      return;
    }
    // open 要等 room:snapshot 才算重新驗證完成；斷線期間保留傳輸，不發新請求。
    if (state.status !== "open") this.connected = false;
    this.publish();
  }

  private handleMessage(message: ServerMessage) {
    if (this.destroyed || this.closed) return;
    if (message.type === "room:snapshot") {
      this.handleSnapshot(message);
      return;
    }
    if (!this.host) return;
    switch (message.type) {
      case "room:members": {
        const next = onlineViewers(message.members);
        for (const id of this.viewers) {
          if (!next.has(id)) this.transport?.removePeer(id);
        }
        this.viewers = next;
        return;
      }
      case "room:updated":
        this.handleRoomUpdated(message.room.mode, message.room.quality);
        return;
      case "stream:status":
        this.handleStreamStatus(message.live, message.title);
        return;
      case "signal":
        this.signalHandler?.({ from: message.from, data: message.data });
        return;
      case "peer:request":
        this.peerHandler?.({ memberId: message.memberId });
        return;
      default:
        return;
    }
  }

  private handleSnapshot(message: ServerMessage & { type: "room:snapshot" }) {
    // 每次驗證都是新的直播工作階段：拆掉舊傳輸，依意圖與最新片源重建（§6「房主重新連線」）。
    this.dropTransport();
    this.op = null;
    this.stopWaiter = null;
    this.clearModeWaiter();
    this.host = message.you.role === "host";
    if (!this.host) {
      this.connected = false;
      this.publish();
      return;
    }
    this.connected = true;
    if (this.intent && this.options.intentStillValid?.() === false) {
      // 斷線期間另一分頁接手並明確停播：這個分頁記得的意圖已過時。
      this.cancelIntent();
      this.error = "另一個分頁已停止直播。需要時請再按「開始直播」。";
    }
    this.mode = message.room.mode;
    this.quality = message.room.quality;
    this.serverLive = message.stream.live;
    this.titles.invalidate();
    this.titles.server = message.stream.title;
    this.viewers = onlineViewers(message.members);
    this.reconcile();
    this.publish();
  }

  private handleRoomUpdated(mode: Mode, quality: Quality) {
    if (quality !== this.quality) {
      this.quality = quality;
      this.transport?.setQuality(quality).catch((error: unknown) => {
        this.showError(error);
      });
    }
    if (mode !== this.mode) {
      this.mode = mode;
      const waiter = this.modeWaiter;
      if (waiter?.mode === mode) {
        this.clearModeWaiter();
        waiter.resolve();
      }
    }
    this.reconcile();
    this.publish();
  }

  private handleStreamStatus(live: boolean, title: string | null) {
    this.serverLive = live;
    this.titles.server = title;
    if (!live) {
      const waiter = this.stopWaiter;
      if (waiter) {
        this.stopWaiter = null;
        waiter();
      } else if (this.transport && !this.op) {
        // 不是自己要求的停播（伺服器改為未開播）：拆掉舊傳輸，依意圖重新開播。
        this.dropTransport();
        this.reconcile();
      }
    }
    this.publish();
  }

  // ── 協調 ───────────────────────────────────────────────

  private usable() {
    return !this.destroyed && !this.closed && this.host && this.connected;
  }

  protected sourceReady() {
    return this.source.status === "ready" && this.source.stream !== null;
  }

  /** 直播中換檔檢查期間（checking）與等房主確認的 warning 保留傳輸，tracks 暫時為 null（§9）。 */
  private sourceHolding() {
    return (
      this.sourceReady() ||
      this.source.status === "checking" ||
      this.source.status === "warning"
    );
  }

  /** 依目前狀態決定要開播、停播、更新片名或切到伺服器的模式。進行中的操作結束後會再呼叫。 */
  protected reconcile() {
    if (this.destroyed || this.closed || !this.host) return;
    // 開播途中按停止：不等 start()，立刻作廢這次開播（含斷線中）。
    if (this.op === "starting" && !this.intent) this.abortStart();
    if (!this.connected) {
      // 斷線中按停止：不能送請求，直接拆掉；重新驗證時伺服器會改為未開播。
      if (this.transport && !this.intent && !this.op) this.dropTransport();
      return;
    }
    if (this.op) return;
    if (this.transport) {
      if (!this.intent || !this.sourceHolding()) {
        void this.stopLive();
        return;
      }
      if (!this.serverLive) return;
      // 模式在開播途中被改了（例如 room:update 與開播同時進行）：照 §6 重建。
      if (this.transport.mode !== this.mode) {
        void this.switchMode(this.mode, false);
        return;
      }
      if (this.sourceReady())
        this.titles.update(streamTitle(this.source.title));
      return;
    }
    if (this.intent && this.sourceReady()) void this.startLive();
  }

  // ── 傳輸 ───────────────────────────────────────────────

  /**
   * 傳輸整體無法繼續：拆掉、取消意圖、讓收看者停止舊連線。
   * `duringStart`：傳輸已就緒、還在等停播或 live:true 的確認；live:true 可能已送出，
   * 一律送 live:false 撤回。
   */
  protected failLive(duringStart = false) {
    const retract = duringStart || this.serverLive;
    this.dropTransport();
    this.op = null;
    this.cancelIntent();
    this.error = duringStart
      ? "無法開始直播：直播傳輸中斷了，請再試一次。"
      : "直播傳輸中斷了，請重新開始直播。";
    if (retract && this.connected) {
      this.options.client
        .request({ type: "stream:status", live: false, title: null })
        .catch(() => {});
    }
    this.publish();
  }

  /**
   * 開播途中房主明確停止：換世代並銷毀傳輸（晚到的 start() 結果、ack 與錯誤都作廢），
   * 傳輸自己依進度清理 WHIP（§4）。`start()` 已完成時 live:true 可能已送出，伺服器也可能
   * 還在上一次直播：送一次停播撤回；開播流程正在確認的停播由那一次的 ack 收尾，不重送。
   */
  private abortStart() {
    const retract = this.readyGeneration === this.generation || this.serverLive;
    // 還在等的停播只有在它送出之後沒有再送過 live:true 時才算數；
    // 否則（例如「開始 → 停止 → 開始 → 停止」回覆都很慢）要為最新的開播再撤回一次。
    const confirming =
      this.stopWaiter !== null && this.stopCovers >= this.liveSends;
    this.dropTransport();
    this.op = null;
    if (retract && !confirming && this.connected) {
      this.confirmStop().catch(() => {});
    }
  }

  private applyTracks() {
    if (!this.transport) return;
    const next = tracksOf(this.source.stream);
    for (const kind of KINDS) {
      if (next[kind] === this.applied[kind]) continue;
      this.applied = { ...this.applied, [kind]: next[kind] };
      this.transport.replaceTrack(kind, next[kind]);
    }
  }

  protected dropTransport() {
    this.generation += 1;
    this.transport?.destroy();
    this.transport = null;
    this.signalHandler = null;
    this.peerHandler = null;
    this.applied = NO_TRACKS;
    this.titles.invalidate();
  }

  protected cancelIntent() {
    if (!this.intent) return;
    this.intent = false;
    this.options.onIntentChange?.(false);
  }

  private clearModeWaiter() {
    this.modeWaiter = null;
    this.timers.clearTimeout(this.modeTimer);
    this.modeTimer = null;
  }

  protected showError(error: unknown) {
    if (this.destroyed || disconnected(error)) return;
    this.error = readable(error);
    this.publish();
  }

  private phase(): HostPhase {
    if (this.op) return this.op;
    if (this.transport && this.serverLive && this.connected) return "live";
    return this.intent ? "waiting" : "idle";
  }

  protected publish() {
    if (this.destroyed) return;
    const next: HostSessionView = {
      intent: this.intent,
      phase: this.phase(),
      error: this.error,
    };
    const prev = this.view;
    if (
      prev.intent === next.intent &&
      prev.phase === next.phase &&
      prev.error === next.error
    ) {
      return;
    }
    this.view = next;
    this.listeners.forEach((listener) => listener());
  }
}
