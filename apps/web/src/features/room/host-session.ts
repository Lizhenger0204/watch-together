import type { Mode, Quality, ServerMessage } from "@project/shared";
import type { ConnectionState } from "../../lib/signal";
import {
  createHostTransport,
  type CreateHostTransport,
  type HostTransport,
  type TransportSignal,
} from "../transport";
import { HostSessionBase } from "./host-session-base";
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
// 送請求、等 ack／廣播與建立傳輸的部分在 host-session-base.ts 的抽象基類。
//
// 房主的 stream:status 一律由本類別送出（取代 RoomPage 原本的 useLiveIntent），不要兩套並存。

export class HostSession extends HostSessionBase {
  private host = false;
  /** 已收到這條連線的 room:snapshot，且連線仍是 open。 */
  private connected = false;
  /** 連線以關閉碼結束（4000 等）：之後什麼都不送。 */
  protected closed = false;
  protected destroyed = false;
  private intent: boolean;
  protected source: HostSource = { stream: null, status: "idle", title: "" };
  protected mode: Mode = "p2p";
  protected quality: Quality = "standard";
  /** 伺服器目前的直播狀態（snapshot、stream:status 廣播、自己 live:true 的 ack）。 */
  protected serverLive = false;
  protected serverTitle: string | null = null;
  /** 直播中已送出、還沒確認的片名更新。 */
  protected pendingTitle: string | null = null;
  /** pendingTitle 用 null 代表「無待送」，但 null 也是合法片名，用這個旗標區分。 */
  protected hasPendingTitle = false;
  private viewers = new Set<string>();
  private transport: HostTransport | null = null;
  /** 最後一次交給傳輸的各 kind track。 */
  private applied: Tracks = NO_TRACKS;
  /** 每次建立或拆掉傳輸、每次重新驗證就加一，讓晚到的回呼失效。 */
  protected generation = 0;
  protected signalHandler: Parameters<TransportSignal["onSignal"]>[0] | null =
    null;
  protected peerHandler:
    Parameters<TransportSignal["onPeerRequest"]>[0] | null = null;
  protected op: Op | null = null;
  /** 等停播確認時，收到 live:false 廣播就呼叫。 */
  protected stopWaiter: (() => void) | null = null;
  /** 切模式第 2 步：收到目標模式的 room:updated 就呼叫。 */
  protected modeWaiter: { mode: Mode; resolve: () => void } | null = null;
  /** modeWaiter 的等待廣播期限計時器。 */
  protected modeTimer: unknown = null;
  private error: string | null = null;
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
    this.mode = message.room.mode;
    this.quality = message.room.quality;
    this.serverLive = message.stream.live;
    this.serverTitle = message.stream.title;
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
    this.serverTitle = title;
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

  private sourceReady() {
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
  private reconcile() {
    if (this.destroyed || this.closed || !this.host) return;
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
      if (this.sourceReady()) this.updateTitle();
      return;
    }
    if (this.intent && this.sourceReady()) void this.startLive();
  }

  private async startLive() {
    const gen = ++this.generation;
    this.op = "starting";
    this.publish();

    let transport: HostTransport;
    try {
      transport = this.build(gen);
    } catch (error) {
      this.failStart(error);
      return;
    }
    this.transport = transport;
    this.applied = tracksOf(this.source.stream);

    try {
      await transport.start();
    } catch (error) {
      if (gen !== this.generation) return;
      if (disconnected(error)) {
        // 不是傳輸本身失敗，是連線中斷：保留意圖，重新驗證（snapshot）後重建。
        this.dropTransport();
        this.op = null;
        this.publish();
        return;
      }
      this.failStart(error);
      return;
    }
    if (gen !== this.generation) return;
    // start() 期間停止意圖、片源換掉或模式被改：這個傳輸已過時，拆掉交給 reconcile 收尾。
    if (!this.intent || !this.sourceReady() || transport.mode !== this.mode) {
      this.op = null;
      if (!this.sourceReady() || transport.mode !== this.mode) {
        this.dropTransport();
      }
      this.reconcile();
      this.publish();
      return;
    }

    // 上一次停播尚未確認（live:false 逾時或傳輸失敗）時，serverLive 仍可能為 true。
    // 先確認停播，伺服器才會在收 live:true 時走 false→true 並對收看者重發 peer:request。
    if (this.serverLive) {
      try {
        await this.confirmStop();
      } catch (error) {
        if (gen !== this.generation) return;
        if (disconnected(error)) {
          this.dropTransport();
          this.op = null;
          this.publish();
          return;
        }
        this.failStart(error);
        return;
      }
      if (gen !== this.generation) return;
    }

    const title = streamTitle(this.source.title);
    try {
      await this.options.client.request({
        type: "stream:status",
        live: true,
        title,
      });
    } catch (error) {
      if (gen !== this.generation) return;
      if (disconnected(error)) {
        // 不是伺服器拒絕：保留意圖，重新驗證（snapshot）後重建。
        this.dropTransport();
        this.op = null;
        this.publish();
        return;
      }
      this.failStart(error);
      return;
    }
    if (gen !== this.generation) return;
    this.serverLive = true;
    this.serverTitle = title;
    this.op = null;
    this.reconcile();
    this.publish();
  }

  /** 開播失敗：拆掉傳輸、取消意圖並顯示錯誤；再按「開始直播」就是重試。 */
  private failStart(error: unknown) {
    this.dropTransport();
    this.op = null;
    this.cancelIntent();
    this.error = `無法開始直播：${readable(error)}`;
    this.publish();
  }

  private async stopLive() {
    if (!this.serverLive) {
      this.dropTransport();
      this.reconcile();
      this.publish();
      return;
    }
    const gen = this.generation;
    this.op = "stopping";
    this.publish();
    try {
      await this.confirmStop();
    } catch (error) {
      if (gen !== this.generation) return;
      this.dropTransport();
      this.op = null;
      if (!disconnected(error)) this.error = readable(error);
      this.publish();
      return;
    }
    if (gen !== this.generation) return;
    this.transport?.stop();
    this.dropTransport();
    this.op = null;
    this.reconcile();
    this.publish();
  }

  /**
   * §6「房主」1～4 步。`sendUpdate` 為 false 表示伺服器的模式已經是 target
   * （開播途中被改），只需要停播、重建。
   */
  private async switchMode(target: Mode, sendUpdate: boolean) {
    const gen = this.generation;
    this.op = "switching";
    this.publish();

    // 1. 停播，等同一 reqId 的 ack 或本次之後的停播廣播。失敗或逾時就停在這一步。
    try {
      await this.confirmStop();
    } catch (error) {
      if (gen !== this.generation) return;
      this.op = null;
      if (!disconnected(error)) {
        this.error = `切換失敗，仍維持原本的傳送方式：${readable(error)}`;
      }
      // 重新讀取意圖：切換途中可能已經按停止，要繼續走停播。
      this.reconcile();
      this.publish();
      return;
    }
    if (gen !== this.generation) return;

    // 2. 停止舊傳輸，再送 room:update；收到目標模式的 room:updated 後才 destroy。
    this.transport?.stop();
    if (sendUpdate) {
      try {
        await this.confirmMode(target);
      } catch (error) {
        if (gen !== this.generation) return;
        this.dropTransport();
        this.op = null;
        if (!disconnected(error)) {
          this.error = `切換傳送方式失敗：${readable(error)}`;
        }
        // 伺服器仍是舊模式：依意圖用舊模式重新開播。
        this.reconcile();
        this.publish();
        return;
      }
      if (gen !== this.generation) return;
    }
    this.dropTransport();
    this.op = null;

    // 3、4. 以最新片源、目前畫質與新模式重建，start() 後才送 live:true。
    this.reconcile();
    this.publish();
  }

  // ── 傳輸 ───────────────────────────────────────────────

  /** 直播中傳輸整體無法繼續：拆掉、取消意圖、讓收看者停止舊連線。 */
  protected failLive() {
    const wasLive = this.serverLive;
    this.dropTransport();
    this.op = null;
    this.cancelIntent();
    this.error = "直播傳輸中斷了，請重新開始直播。";
    if (wasLive && this.connected) {
      this.options.client
        .request({ type: "stream:status", live: false, title: null })
        .catch(() => {});
    }
    this.publish();
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

  private dropTransport() {
    this.generation += 1;
    this.transport?.destroy();
    this.transport = null;
    this.signalHandler = null;
    this.peerHandler = null;
    this.applied = NO_TRACKS;
    this.pendingTitle = null;
    this.hasPendingTitle = false;
  }

  private cancelIntent() {
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
