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
import type { TransportError } from "./common/errors";
import type { PeerConnectionFactory } from "./common/rtc";
import type { TransportStats } from "./common/stats";

export * from "./common";

/**
 * 傳輸層需要的最小 signal 介面（不直接依賴 lib/signal.ts 的 SignalClient 類別）。
 * T-115 不必等 T-105；GPT 寫 p2p/ 時也能用 fake signal 測試。
 *
 * - `sendSignal`：送出 WebRTC 信令。房主送給某位收看者；收看者送給房主
 *   （protocol.md：收看者的 signal 伺服器只會轉給房主）。
 * - `onSignal`：收到信令（`from` = 來源 memberId；收看者收到時是房主，
 *   房主收到時是某位收看者）。
 * - `onPeerRequest`：**僅房主**。有新收看者上線、或需要重連時觸發。
 */
export interface TransportSignal {
  sendSignal(to: string, data: SignalData): void;
  onSignal(
    handler: (message: { from: string; data: SignalData }) => void,
  ): Unsubscribe;
  onPeerRequest(handler: (request: { memberId: string }) => void): Unsubscribe;
}

/** 房主傳輸的整體狀態。 */
export type HostTransportState = "idle" | "live" | "error";

/** 收看者傳輸的狀態；沿用 protocol.md 的 MemberState。 */
export type ViewerTransportState = MemberState;

/** 房主傳輸（送出 stream、管理對每位收看者的連線）。 */
export interface HostTransport {
  /** 建立時的模式；切換模式是「拆掉重建」，不是改這個欄位。 */
  readonly mode: Mode;
  /** 送出的串流（房主 captureStream，所有連線共用同一個）。 */
  readonly stream: MediaStream;

  /** 開始傳輸：加 track、依序建立連線；relay 模式在此 POST WHIP。 */
  start(): void;
  /** 停止傳輸但保留物件（可再 start()）。 */
  stop(): void;

  /** 換片 / track 異動時替換所有連線的 track（streaming.md §1，用 replaceTrack）。 */
  replaceTrack(kind: "video" | "audio", track: MediaStreamTrack | null): void;
  /** 播放中切畫質（不重建連線，用 setParameters）。 */
  setQuality(quality: Quality): void;

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

  /** 釋放所有 RTCPeerConnection、track 與監聽；呼叫後不可再用。 */
  destroy(): void;
}

/** 收看者傳輸（接收 stream、提供 remoteStream）。 */
export interface ViewerTransport {
  readonly mode: Mode;
  /** 收看端 `<video srcObject>` 用的串流。 */
  readonly remoteStream: MediaStream;

  /** 開始接收。relay：等房主開播（stream:status live）時呼叫；p2p：準備好等 offer。 */
  start(): void;
  /** 停止接收但保留物件（可再 start()）。 */
  stop(): void;

  onState(handler: (state: ViewerTransportState) => void): Unsubscribe;
  onStats(handler: (stats: TransportStats) => void): Unsubscribe;
  onError(handler: (error: TransportError) => void): Unsubscribe;

  /** 釋放連線、track 與監聽；呼叫後不可再用。 */
  destroy(): void;
}

/** 兩種傳輸共用的可注入選項。 */
export interface TransportRtcOptions {
  /** 每次建連線前取 ICE servers；省略時用 common/ice.ts 的 fetchIceServers。 */
  fetchIceServers?: () => Promise<RTCIceServer[]>;
  /** RTCPeerConnection 工廠；省略時用瀏覽器原生，測試注入 fake。 */
  createPeerConnection?: PeerConnectionFactory;
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
