import {
  MEMBER_STATUS_INTERVAL_MS,
  type ClientMessageOf,
  type MemberState,
  type MemberStatus,
  type Mode,
  type ServerMessage,
  type SignalData,
} from "@project/shared";
import type { ConnectionState } from "../../lib/signal";
import {
  createViewerTransport,
  TransportError,
  type CreateViewerTransport,
  type TransportSignal,
  type TransportStats,
  type ViewerTransport,
} from "../transport";

// 收看者的房間層（streaming.md §3「收看者等待第一份 offer」「收看者手動重連」、§6、§8）：
// 依 room:snapshot／stream:status／room:updated 建立與銷毀 viewer transport，
// 緩衝訂閱就緒前到達的信令，計時等待首份 offer，並每 5 秒回報 member:status。
// 不依賴 React；SignalClient、傳輸工廠與計時器都可注入。

/** 確認直播且訂閱就緒後，等房主第一份 offer 的期限（§3，建議 20 秒）。 */
export const FIRST_OFFER_TIMEOUT_MS = 20_000;

const MAX_BUFFERED_SIGNALS = 128;

type SignalMessage = { from: string; data: SignalData };

export interface ViewerSessionClient {
  onState(handler: (state: ConnectionState) => void): () => void;
  onMessage(handler: (message: ServerMessage) => void): () => void;
  send(
    message: ClientMessageOf<"signal"> | ClientMessageOf<"member:status">,
  ): boolean;
}

export type SessionTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

export type ViewerSessionOptions = {
  client: ViewerSessionClient;
  roomId: string;
  /** memberToken。不可寫進 log。 */
  token: string;
  /** P2P 手動重連：由房間層換一條新的 WebSocket 重新驗證。 */
  requestNewSocket: () => void;
  createTransport?: CreateViewerTransport;
  timers?: SessionTimers;
};

export type ViewerView = {
  /** 房主正在直播（依 snapshot 與 stream:status）。 */
  live: boolean;
  /** 回報給房主的狀態，也是播放器顯示的狀態。 */
  state: MemberState;
  /** 目前傳輸的固定 MediaStream；沒有傳輸時為 null。 */
  remoteStream: MediaStream | null;
  /** 讓 UI 顯示的錯誤（連線失敗、轉發不可用）。 */
  error: TransportError | null;
};

const browserTimers: SessionTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as number),
};

export class ViewerSession {
  private awaitingSnapshot = true;
  private detachClient?: () => void;
  private member = false;
  private mode: Mode = "p2p";
  private live = false;
  private transport: ViewerTransport | null = null;
  /** 每次建立或拆掉傳輸就加一，讓舊傳輸晚到的回呼失效。 */
  private generation = 0;
  private handler: ((message: SignalMessage) => void) | null = null;
  private ready = false;
  private buffer: SignalMessage[] = [];
  private offerSeen = false;
  /** 當代 WHEP 回 409（STREAM_NOT_LIVE）：維持 waiting，下一個開播廣播再拉一次。 */
  private retryOnLive = false;
  private offerTimer: unknown = null;
  private statusTimer: unknown = null;
  private transportState: MemberState = "waiting";
  private stats: TransportStats | null = null;
  private error: TransportError | null = null;
  private buffering = false;
  private lastReported: MemberState | null = null;
  private destroyed = false;
  private view: ViewerView = {
    live: false,
    state: "waiting",
    remoteStream: null,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly createTransport: CreateViewerTransport;
  private readonly timers: SessionTimers;

  constructor(private readonly options: ViewerSessionOptions) {
    this.createTransport = options.createTransport ?? createViewerTransport;
    this.timers = options.timers ?? browserTimers;
  }

  /** 在 SignalClient.start() 之前呼叫，才不會漏掉驗證後馬上到的信令。 */
  attach() {
    const offMessage = this.options.client.onMessage((message) =>
      this.handle(message),
    );
    const offState = this.options.client.onState((state) => {
      if (state.status === "closed") this.destroy();
      else if (state.status !== "open") this.resetSocket();
    });
    this.detachClient = () => {
      offMessage();
      offState();
    };
    return () => this.destroy();
  }

  getView = () => this.view;

  /** 播放器取樣時讀當代傳輸最近的接收碼率；尚無統計時只靠媒體本身判斷。 */
  getReceiveBitrate = () => this.stats?.bitrateKbps;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 播放器偵測到 `<video>` 停滯／恢復（§9：buffering 由播放器回報）。 */
  setBuffering(buffering: boolean, stream = this.transport?.remoteStream) {
    if (
      !stream ||
      stream !== this.transport?.remoteStream ||
      this.buffering === buffering
    )
      return;
    this.buffering = buffering;
    this.publish();
  }

  /** 收看者按「重新連線」。P2P 換新的 WebSocket；轉發直接重新拉取。 */
  reconnect() {
    if (!this.member || this.destroyed) return;
    if (this.mode === "p2p") {
      this.destroy();
      this.options.requestNewSocket();
    } else if (this.live) {
      this.teardown();
      this.connect();
      this.publish();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.detachClient?.();
    this.detachClient = undefined;
    this.resetSocket();
    this.destroyed = true;
    this.listeners.clear();
  }

  private resetSocket() {
    this.member = false;
    this.live = false;
    this.awaitingSnapshot = true;
    this.teardown();
    this.timers.clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.lastReported = null;
    this.publish();
  }

  private handle(message: ServerMessage) {
    if (this.destroyed) return;
    switch (message.type) {
      case "room:snapshot": {
        // 只有本條 socket 在首份 snapshot 前收到的信令能交給新傳輸。
        const pending = this.awaitingSnapshot ? this.buffer : [];
        this.teardown();
        this.awaitingSnapshot = false;
        this.member = message.you.role === "member";
        this.mode = message.room.mode;
        this.live = message.stream.live;
        this.lastReported = null;
        if (!this.member) return;
        this.startStatusTimer();
        if (this.live) {
          if (this.mode === "p2p") this.buffer = pending;
          this.connect();
        }
        this.publish();
        return;
      }
      case "room:closed":
        this.destroy();
        return;
      case "stream:status":
        if (!this.member) return;
        if (message.live && (!this.live || this.retryOnLive)) {
          this.live = true;
          this.connect();
        } else if (!message.live) {
          this.live = false;
          this.teardown();
        }
        // 直播中更新片名等重複的開播廣播不重設計時（§3）。
        this.publish();
        return;
      case "room:updated":
        if (!this.member || message.room.mode === this.mode) return;
        this.mode = message.room.mode;
        this.teardown();
        if (this.live) this.connect();
        else this.prepare();
        this.publish();
        return;
      case "signal":
        if (this.awaitingSnapshot || (this.mode === "p2p" && this.transport))
          this.deliver({ from: message.from, data: message.data });
        return;
      default:
        return;
    }
  }

  private prepare() {
    const generation = ++this.generation;
    const current = () => generation === this.generation && !this.destroyed;
    const signal: TransportSignal = {
      sendSignal: (to, data) =>
        current() && this.options.client.send({ type: "signal", to, data }),
      onSignal: (handler) => {
        if (current()) this.handler = handler;
        return () => {
          if (this.handler === handler) this.handler = null;
        };
      },
      onPeerRequest: () => () => {},
    };

    let transport: ViewerTransport;
    try {
      transport = this.createTransport({
        signal,
        mode: this.mode,
        roomId: this.options.roomId,
        token: this.options.token,
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    this.transport = transport;
    transport.onState((state) => {
      if (!current()) return;
      this.transportState = state;
      if (state === "playing") this.error = null;
      this.publish();
    });
    transport.onStats((stats) => {
      if (current()) this.stats = stats;
    });
    transport.onError((error) => {
      if (!current() || error.code === "STREAM_NOT_LIVE") return;
      this.error = error;
      this.publish();
    });
    return transport;
  }

  private connect() {
    // room:updated 可能已經建立傳輸；開播後沿用它，WHEP 和首份 offer 計時都從這次啟動。
    const transport = this.transport ?? this.prepare();
    if (!transport) return;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.retryOnLive = false;
    this.transportState = "connecting";
    transport.start().then(
      () => {
        if (!current()) return;
        this.ready = true;
        const buffered = this.buffer;
        this.buffer = [];
        for (const message of buffered) {
          this.deliver(message);
          if (!current()) return;
        }
        // 訂閱就緒前已緩衝 offer 就不計時；否則開始等首份 offer（P2P）。
        if (this.mode === "p2p" && !this.offerSeen) {
          this.offerTimer = this.timers.setTimeout(() => {
            if (!current()) return;
            this.fail(
              new TransportError(
                "PEER_FAILED",
                "等不到房主的連線，請按「重新連線」再試一次。",
              ),
            );
          }, FIRST_OFFER_TIMEOUT_MS);
        }
      },
      (error: unknown) => {
        if (!current()) return;
        // 轉發尚未有可收看的發布（§9）：不是失敗，保留傳輸等下一個開播廣播。
        if (
          error instanceof TransportError &&
          error.code === "STREAM_NOT_LIVE"
        ) {
          this.retryOnLive = true;
          this.transportState = "waiting";
          this.publish();
          return;
        }
        this.fail(error);
      },
    );
  }

  private deliver(message: SignalMessage) {
    if (!this.ready) {
      if (this.buffer.length >= MAX_BUFFERED_SIGNALS) {
        // 保留已排隊的 offer；一份更新的 offer 可以取代滿載的舊協商。
        if (message.data.type !== "offer") return;
        this.buffer = [];
      }
      this.buffer.push(message);
      return;
    }
    if (!this.handler) return;
    if (message.data.type === "offer" && !this.offerSeen) {
      this.offerSeen = true;
      this.timers.clearTimeout(this.offerTimer);
      this.offerTimer = null;
    }
    this.handler(message);
  }

  /** 拆掉傳輸並顯示失敗，等收看者按「重新連線」。 */
  private fail(error: unknown) {
    this.teardown();
    this.transportState = "failed";
    this.error =
      error instanceof TransportError
        ? error
        : new TransportError("PEER_FAILED", "影音連線失敗", { cause: error });
    this.publish();
  }

  private teardown() {
    this.generation += 1;
    this.timers.clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.transport?.destroy();
    this.transport = null;
    this.handler = null;
    this.ready = false;
    this.buffer = [];
    this.offerSeen = false;
    this.retryOnLive = false;
    this.transportState = "waiting";
    this.stats = null;
    this.error = null;
    this.buffering = false;
  }

  private reportedState(): MemberState {
    if (!this.live) return "waiting";
    if (this.transportState === "playing" && this.buffering) return "buffering";
    return this.transportState;
  }

  private startStatusTimer() {
    if (this.statusTimer !== null) return;
    this.statusTimer = this.timers.setInterval(
      () => this.report(),
      MEMBER_STATUS_INTERVAL_MS,
    );
  }

  /** §8：送自己的 state 與有值的統計欄位。 */
  private report() {
    if (!this.member || this.destroyed) return;
    const state = this.reportedState();
    const status: MemberStatus = { state };
    if ((state === "playing" || state === "buffering") && this.stats) {
      status.bitrateKbps = this.stats.bitrateKbps;
      if (this.stats.rttMs !== undefined) status.rttMs = this.stats.rttMs;
      if (this.stats.packetLoss !== undefined)
        status.packetLoss = this.stats.packetLoss;
    }
    this.lastReported = state;
    this.options.client.send({ type: "member:status", ...status });
  }

  private publish() {
    if (this.destroyed) return;
    const state = this.reportedState();
    // 狀態一變就回報，不等下一次 5 秒（房主的成員列表才不會落後）。
    if (this.member && state !== this.lastReported) this.report();
    const next: ViewerView = {
      live: this.live,
      state,
      remoteStream: this.transport?.remoteStream ?? null,
      error: this.error,
    };
    const prev = this.view;
    if (
      prev.live === next.live &&
      prev.state === next.state &&
      prev.remoteStream === next.remoteStream &&
      prev.error === next.error
    ) {
      return;
    }
    this.view = next;
    this.listeners.forEach((listener) => listener());
  }
}
