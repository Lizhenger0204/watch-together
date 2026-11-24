/**
 * 傳輸層的對外契約（docs/specs/streaming.md §9）。
 *
 * 這裡只放「型別與介面」，不放實作。實作由：
 * - `p2p/`（GPT）：房主 mesh、收看者連線、信令處理。
 * - `relay/`（Claude）：WHIP / WHEP 客戶端。
 * 各模式實作都實作 `CreateHostTransport`／`CreateViewerTransport`，之後再由
 * 上層（房間 hook）依 `mode` 選用；切換模式 = 拆掉舊傳輸、建立新傳輸。
 *
 * 本層是純 TS，不 import React。RTCPeerConnection 一律透過
 * `common/rtc.ts` 的介面，測試注入 `common/rtc-fake.ts` 的 fake。
 */
import type { MemberState, Mode, Quality, SignalData } from "@project/shared";
import type { Unsubscribe } from "./common/emitter";
import type { CodecCapabilities } from "./common/encoding";
import type { TransportError } from "./common/errors";
import type { PeerConnectionFactory } from "./common/rtc";
import type { TransportStats } from "./common/stats";

export * from "./common";

/**
 * 傳輸層需要的最小 signal 介面（不直接依賴 lib/signal.ts 的 SignalClient 類別）。
 * T-115 不必等 T-105；GPT 寫 p2p/ 時也能用 fake signal 測試。
 *
 * - `sendSignal`：送出 WebRTC 信令。房主送給某位收看者；收看者送給房主
 *   （protocol.md：收看者的 signal 伺服器只會轉給房主）。回傳是否成功送出
 *   （WebSocket 未連線等情況回 `false`，adapter 要把它轉成 `SIGNAL_ERROR`）。
 * - `onSignal`：收到信令（`from` = 來源 memberId；收看者收到時是房主，
 *   房主收到時是某位收看者）。
 * - `onPeerRequest`：**僅房主**。有新收看者上線、或需要重連時觸發。
 */
export interface TransportSignal {
  sendSignal(to: string, data: SignalData): boolean;
  onSignal(
    handler: (message: { from: string; data: SignalData }) => void,
  ): Unsubscribe;
  onPeerRequest(handler: (request: { memberId: string }) => void): Unsubscribe;
}

/** 房主傳輸的整體狀態。 */
export type HostTransportState = "idle" | "live" | "error";

/** 收看者傳輸的狀態；沿用 protocol.md 的 MemberState。 */
export type ViewerTransportState = MemberState;

/**
 * 房主傳輸（送出 stream、管理對每位收看者的連線）。
 *
 * track 所有權：captureStream 產生的 track 由 `features/source/`（T-106）持有與
 * 停止，**傳輸層絕不 `stop()` 這些 track**。`destroy()` 只釋放 RTCPeerConnection
 * 與監聽，不碰 capture track。下一個傳輸（切換模式、重連）沿用同一份 capture
 * stream 與 track。
 */
export interface HostTransport {
  /** 建立時的模式；切換模式是「拆掉重建」，不是改這個欄位。 */
  readonly mode: Mode;
  /** 送出的串流（房主 captureStream，所有連線共用同一個）。 */
  readonly stream: MediaStream;

  /**
   * 開始傳輸。回傳的 Promise 在「可以宣布開播」時 resolve：
   * - relay：WHIP 回 201 且套用 answer 之後。
   * - p2p：signal 訂閱（`onPeerRequest`／`onSignal`）就緒、且 capture track 已
   *   套用到 sender 之後（之後伺服器才會送 `peer:request`）。
   * 房間層在 `await start()` 之後才送 `stream:status { live: true }`。
   */
  start(): Promise<void>;
  /** 停止傳輸但保留物件（可再 start()）；會拆除連線／WHIP，失敗走 onError。 */
  stop(): void;

  /**
   * 換片 / track 異動時替換所有連線的 track（streaming.md §1，用 replaceTrack）。
   * `track` 為 null 代表「暫時沒有這個 kind 的 track」（例如影片播完），不是停止
   * 直播；停止直播請用 `stop()`。傳輸會記住最新 track 與畫質，套用到現有與之後
   * 新建的 sender，並依新影片高度重算縮放。
   */
  replaceTrack(kind: "video" | "audio", track: MediaStreamTrack | null): void;

  /**
   * 播放中切畫質（不重建連線，用 setParameters）。依序套用到所有 sender，
   * 失敗丟出帶 memberId 的 `TRACK_ERROR`。
   */
  setQuality(quality: Quality): Promise<void>;

  /**
   * 逐人關閉：關閉與某位收看者的連線，並取消該人在途的建連、ICE restart 與統計
   * 計時。冪等（對不存在或已關閉的 memberId 呼叫是 no-op）。房間層比對
   * `room:members`，對消失或 `online: false` 的成員呼叫它（踢人、收看者離線）。
   */
  removePeer(memberId: string): void;

  onState(handler: (state: HostTransportState) => void): Unsubscribe;
  /** 每位收看者的連線狀態（P2P；relay 模式下沒有逐人連線，不觸發）。 */
  onPeerState(
    handler: (peer: { memberId: string; state: MemberState }) => void,
  ): Unsubscribe;
  /** 每位收看者的統計（P2P 每 2 秒；relay 模式回報單一上傳統計，無 memberId）。 */
  onStats(
    handler: (stats: TransportStats & { memberId?: string }) => void,
  ): Unsubscribe;
  onError(handler: (error: TransportError) => void): Unsubscribe;

  /** 釋放所有 RTCPeerConnection、監聽與計時；不停止 capture track。呼叫後不可再用。 */
  destroy(): void;
}

/** 收看者傳輸（接收 stream、提供 remoteStream）。 */
export interface ViewerTransport {
  readonly mode: Mode;
  /**
   * 收看端 `<video srcObject>` 用的串流。**建立時就固定同一個 MediaStream**，
   * 之後用 ontrack 的 `event.track` 加進去（不要依賴 `event.streams`，Chrome 上
   * sendonly transceiver 的 streams 可能是空的）；停止或重連時移除舊 track。
   * 這樣 T-110 只要綁一次 `srcObject`。
   */
  readonly remoteStream: MediaStream;

  /**
   * 開始接收。回傳的 Promise 在「準備好接收」時 resolve：
   * - relay：WHEP 回 201 且套用 answer（收到遠端 track）之後。
   * - p2p：signal 訂閱就緒之後（之後房主才會送 offer）。
   * 已經開播才加入的收看者，依 snapshot 的 `stream.live: true` 直接 `start()`。
   */
  start(): Promise<void>;
  /** 停止接收但保留物件（可再 start()）；會移除 remoteStream 舊 track。 */
  stop(): void;

  onState(handler: (state: ViewerTransportState) => void): Unsubscribe;
  onStats(handler: (stats: TransportStats) => void): Unsubscribe;
  onError(handler: (error: TransportError) => void): Unsubscribe;

  /** 釋放連線、監聽與計時；不停止 capture track。呼叫後不可再用。 */
  destroy(): void;
}

/** 兩種傳輸共用的可注入選項。 */
export interface TransportRtcOptions {
  /** 每次建連線前取 ICE servers；省略時用 common/ice.ts 的 fetchIceServers。 */
  fetchIceServers?: () => Promise<RTCIceServer[]>;
  /** RTCPeerConnection 工廠；省略時用瀏覽器原生 adapter，測試注入 fake。 */
  createPeerConnection?: PeerConnectionFactory;
  /** 依 kind 取 codec 能力；省略時用 `browserCodecCapabilities`。 */
  getCodecCapabilities?: CodecCapabilities;
}

export interface HostTransportOptions extends TransportRtcOptions {
  stream: MediaStream;
  signal: TransportSignal;
  mode: Mode;
  quality: Quality;
  /** 取 ICE 的房間 id。 */
  roomId: string;
  /** hostToken（Bearer token），呼叫 /ice 與 WHIP 用。不可寫進 log。 */
  token: string;
}

export interface ViewerTransportOptions extends TransportRtcOptions {
  signal: TransportSignal;
  mode: Mode;
  roomId: string;
  /** memberToken（Bearer token），呼叫 /ice 與 WHEP 用。不可寫進 log。 */
  token: string;
}

export type CreateHostTransport = (
  options: HostTransportOptions,
) => HostTransport;

export type CreateViewerTransport = (
  options: ViewerTransportOptions,
) => ViewerTransport;
