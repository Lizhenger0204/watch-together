import type {
  ClientMessageOf,
  Member,
  Mode,
  Quality,
  ServerMessage,
} from "@project/shared";
import { ApiError } from "../../lib/api";
import {
  SignalDisconnectedError,
  type ConnectionState,
} from "../../lib/signal";
import {
  createHostTransport,
  TransportError,
  type CreateHostTransport,
  type HostTransport,
  type TransportSignal,
} from "../transport";
import { streamTitle } from "./live-intent";
import type { SessionTimers } from "./viewer-session";

// 房主的房間層（streaming.md §1、§6、§9「生命週期與誰協調」）：
// 依開播意圖、片源與伺服器狀態建立／銷毀 host transport，
// await start() 後才送 stream:status { live: true }；換片走 replaceTrack；
// 收看者消失或離線時 removePeer；直播中切模式照 §6「房主」1～4 步；
// 重新驗證（room:snapshot）時拆掉舊傳輸再依意圖重建；連線以 4000 等關閉時銷毀傳輸。
// 不依賴 React；SignalClient、傳輸工廠與計時器都可注入。
//
// 房主的 stream:status 一律由本類別送出（取代 RoomPage 原本的 useLiveIntent），不要兩套並存。

/** useLocalSource 的片源狀態（check.status 原樣傳入）。 */
export type HostSource = {
  stream: MediaStream | null;
  status: "idle" | "checking" | "ready" | "warning" | "error";
  /** 去掉副檔名的檔名；送出前用 live-intent.ts 的 streamTitle 截斷。 */
  title: string;
};

export type HostPhase =
  /** 沒有開播意圖。 */
  | "idle"
  /** 有開播意圖，但暫時不能開播（未連線、片源未就緒）。UI 顯示「直播暫停中」。 */
  | "waiting"
  /** 建立傳輸、await start()、送 live:true 中。 */
  | "starting"
  /** 伺服器已確認直播。 */
  | "live"
  /** 送出 live:false，等確認。 */
  | "stopping"
  /** §6 直播中切模式 1～4 步進行中。UI 顯示「切換中」。 */
  | "switching";

export type HostSessionView = {
  intent: boolean;
  phase: HostPhase;
  /** 給房主看的可讀錯誤（開播失敗、轉發不可用、切換失敗、畫質套用失敗）。 */
  error: string | null;
};

type HostRequest =
  | Omit<ClientMessageOf<"stream:status">, "reqId">
  | Omit<ClientMessageOf<"room:update">, "reqId">;

/** SignalClient 的子集（測試注入 fake）。 */
export interface HostSessionClient {
  onMessage(handler: (message: ServerMessage) => void): () => void;
  onState(handler: (state: ConnectionState) => void): () => void;
  send(message: ClientMessageOf<"signal">): boolean;
  /** 等同一 reqId 的 ack；失敗以 ApiError（連線中斷為 SignalDisconnectedError）reject。 */
  request(message: HostRequest): Promise<void>;
}

export type HostSessionOptions = {
  client: HostSessionClient;
  roomId: string;
  /** hostToken。不可寫進 log。 */
  token: string;
  /** 分頁儲存的開播意圖（liveIntent.get）。 */
  initialIntent: boolean;
  /** 意圖改變時呼叫（由 hook 寫回 liveIntent）。 */
  onIntentChange?: (on: boolean) => void;
  createTransport?: CreateHostTransport;
  /** 目前沒有自己的計時（逾時沿用 SignalClient.request 的 10 秒）；保留注入點。 */
  timers?: SessionTimers;
};

type Kind = "video" | "audio";
type Tracks = Record<Kind, MediaStreamTrack | null>;
type Op = "starting" | "stopping" | "switching";

const KINDS: Kind[] = ["video", "audio"];
const NO_TRACKS: Tracks = { video: null, audio: null };

/** 和 P2P host 的 start() 一樣：各 kind 取第一條還沒結束的 track。 */
function tracksOf(stream: MediaStream | null): Tracks {
  if (!stream) return NO_TRACKS;
  const pick = (list: MediaStreamTrack[]) =>
    list.find((track) => track.readyState !== "ended") ?? null;
  return {
    video: pick(stream.getVideoTracks()),
    audio: pick(stream.getAudioTracks()),
  };
}

function onlineViewers(members: Member[]) {
  return new Set(
    members
      .filter((m) => m.role === "member" && m.online)
      .map((m) => m.memberId),
  );
}

const disconnected = (error: unknown) =>
  error instanceof SignalDisconnectedError;

function readable(error: unknown): string {
  if (error instanceof TransportError || error instanceof ApiError) {
    return error.message;
  }
  return "操作失敗，請稍後再試。";
}

export class HostSession {
  private host = false;
  /** 已收到這條連線的 room:snapshot，且連線仍是 open。 */
  private connected = false;
  /** 連線以關閉碼結束（4000 等）：之後什麼都不送。 */
  private closed = false;
  private destroyed = false;
  private intent: boolean;
  private source: HostSource = { stream: null, status: "idle", title: "" };
  private mode: Mode = "p2p";
  private quality: Quality = "standard";
  /** 伺服器目前的直播狀態（snapshot、stream:status 廣播、自己 live:true 的 ack）。 */
  private serverLive = false;
  private serverTitle: string | null = null;
  /** 直播中已送出、還沒確認的片名更新。 */
  private pendingTitle: string | null = null;
  private viewers = new Set<string>();
  private transport: HostTransport | null = null;
  /** 最後一次交給傳輸的各 kind track。 */
  private applied: Tracks = NO_TRACKS;
  /** 每次建立或拆掉傳輸、每次重新驗證就加一，讓晚到的回呼失效。 */
  private generation = 0;
  private signalHandler: Parameters<TransportSignal["onSignal"]>[0] | null =
    null;
  private peerHandler: Parameters<TransportSignal["onPeerRequest"]>[0] | null =
    null;
  private op: Op | null = null;
  /** 等停播確認時，收到 live:false 廣播就呼叫。 */
  private stopWaiter: (() => void) | null = null;
  /** 切模式第 2 步：收到目標模式的 room:updated 就呼叫。 */
  private modeWaiter: { mode: Mode; resolve: () => void } | null = null;
  private error: string | null = null;
  private view: HostSessionView;
  private readonly listeners = new Set<() => void>();
  private readonly createTransport: CreateHostTransport;

  constructor(private readonly options: HostSessionOptions) {
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
    this.modeWaiter = null;
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
    this.modeWaiter = null;
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
        this.modeWaiter = null;
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

  /** 直播中換檔檢查期間（checking）保留傳輸，tracks 暫時為 null（§9）。 */
  private sourceHolding() {
    return this.sourceReady() || this.source.status === "checking";
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
      if (gen === this.generation) this.failStart(error);
      return;
    }
    if (gen !== this.generation) return;
    // start() 期間停止意圖、片源壞掉或模式被改：交給 reconcile 收尾。
    if (!this.intent || !this.sourceReady() || transport.mode !== this.mode) {
      this.op = null;
      if (transport.mode !== this.mode) this.dropTransport();
      this.reconcile();
      this.publish();
      return;
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

  /** 送停播；同一 reqId 的 ack 或之後的 live:false 廣播先到者為確認。 */
  private confirmStop(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onBroadcast = () => settle(resolve);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.stopWaiter === onBroadcast) this.stopWaiter = null;
        fn();
      };
      this.stopWaiter = onBroadcast;
      this.options.client
        .request({ type: "stream:status", live: false, title: null })
        .then(
          () => {
            this.serverLive = false;
            this.serverTitle = null;
            settle(resolve);
          },
          (error: unknown) => settle(() => reject(error)),
        );
    });
  }

  /** 送 room:update { mode }，收到該模式的 room:updated 才 resolve。 */
  private confirmMode(target: Mode): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = { mode: target, resolve };
      this.modeWaiter = waiter;
      this.options.client
        .request({ type: "room:update", mode: target })
        .catch((error: unknown) => {
          if (this.modeWaiter !== waiter) return;
          this.modeWaiter = null;
          reject(error);
        });
    });
  }

  private updateTitle() {
    const title = streamTitle(this.source.title);
    if (title === this.serverTitle || title === this.pendingTitle) return;
    const gen = this.generation;
    this.pendingTitle = title;
    this.options.client
      .request({ type: "stream:status", live: true, title })
      .then(
        () => {
          if (gen !== this.generation || this.pendingTitle !== title) return;
          this.pendingTitle = null;
          this.serverTitle = title;
          this.publish();
        },
        (error: unknown) => {
          if (gen !== this.generation || this.pendingTitle !== title) return;
          this.pendingTitle = null;
          this.showError(error);
        },
      );
  }

  // ── 傳輸 ───────────────────────────────────────────────

  private build(gen: number): HostTransport {
    const current = () =>
      gen === this.generation && !this.destroyed && !this.closed;
    const signal: TransportSignal = {
      sendSignal: (to, data) =>
        current() && this.options.client.send({ type: "signal", to, data }),
      onSignal: (handler) => {
        if (current()) this.signalHandler = handler;
        return () => {
          if (this.signalHandler === handler) this.signalHandler = null;
        };
      },
      onPeerRequest: (handler) => {
        if (current()) this.peerHandler = handler;
        return () => {
          if (this.peerHandler === handler) this.peerHandler = null;
        };
      },
    };
    const transport = this.createTransport({
      stream: this.source.stream!,
      signal,
      mode: this.mode,
      quality: this.quality,
      roomId: this.options.roomId,
      token: this.options.token,
    });
    transport.onError((error) => {
      // 個別收看者的連線失敗由傳輸自己 removePeer；只顯示畫質套用失敗。
      if (current() && error.code === "TRACK_ERROR") this.showError(error);
    });
    transport.onState((state) => {
      // 開播中的失敗由 start() 的 reject 處理。
      if (state === "error" && current() && this.op !== "starting") {
        this.failLive();
      }
    });
    return transport;
  }

  /** 直播中傳輸整體無法繼續：拆掉、取消意圖、讓收看者停止舊連線。 */
  private failLive() {
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
  }

  private cancelIntent() {
    if (!this.intent) return;
    this.intent = false;
    this.options.onIntentChange?.(false);
  }

  private showError(error: unknown) {
    if (this.destroyed || disconnected(error)) return;
    this.error = readable(error);
    this.publish();
  }

  private phase(): HostPhase {
    if (this.op) return this.op;
    if (this.transport && this.serverLive && this.connected) return "live";
    return this.intent ? "waiting" : "idle";
  }

  private publish() {
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
