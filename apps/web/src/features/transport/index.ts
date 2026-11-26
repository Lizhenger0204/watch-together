/**
 * 傳輸層的對外契約（docs/specs/streaming.md §9）。
 *
 * 這裡只放「型別與介面」，不放實作。實作由：
 * - `p2p/`（GPT）：房主 mesh、收看者連線、信令處理。
 * - `relay/`（Claude）：WHIP / WHEP 客戶端。
 * 兩種模式共用 `CreateHostTransport`／`CreateViewerTransport`。整合後由本檔的
 * 工廠依 `mode` 選用實作，房間 hook 負責切模式時銷毀舊傳輸、建立新傳輸。
 *
 * 本層是純 TS，不 import React。RTCPeerConnection 一律透過
 * `common/rtc.ts` 的介面，測試注入 `common/rtc-fake.ts` 的 fake。
 */
import type {
  EncodingTarget,
  MemberState,
  Mode,
  SignalData,
} from "@project/shared";
import type { Unsubscribe } from "./common/emitter";
import type { CodecCapabilities } from "./common/encoding";
import { TransportError } from "./common/errors";
import type { PeerConnectionFactory } from "./common/rtc";
import type { TransportStats } from "./common/stats";
import { createP2PHostTransport, createP2PViewerTransport } from "./p2p";
import { createRelayHostTransport, createRelayViewerTransport } from "./relay";

export * from "./common";

/**
 * 傳輸層需要的最小 signal 介面（不直接依賴 lib/signal.ts 的 SignalClient 類別）。
 * T-115 不必等 T-105；GPT 寫 p2p/ 時也能用 fake signal 測試。
 *
 * - `sendSignal`：送出 WebRTC 信令。房主送給某位收看者；收看者送給房主
 *   （protocol.md：收看者的 signal 伺服器只會轉給房主）。回傳是否成功送出
 *   （WebSocket 未連線等情況回 `false`，adapter 要把它轉成 `SIGNAL_ERROR`）。
 * - 每份 offer（含 ICE restart）用新的 `crypto.randomUUID()` 作為 negotiationId。
 *   answer 與雙方 ICE（含 null）都帶回所屬 offer 的識別。
 * - `onSignal`：房主按 from 找到收看者，收看者按房主的 offer 登記當次識別。
 *   先比對 from、negotiationId，再套用 answer 或 ICE。不符就靜默丟棄。
 * - `onPeerRequest`：P2P 房主收到建連請求。同一成員再次被請求時，作廢舊協商
 *   代次（含在途建連、ICE 佇列、重試計時與統計）並關閉舊連線。
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

/** 沿用 MemberState。P2P 等首份 offer 逾時時，房間層以 PEER_FAILED 回報 failed。 */
export type ViewerTransportState = MemberState;

/**
 * 房主傳輸（送出 stream、管理對每位收看者的連線）。
 *
 * T-106 每次選檔擷取一份 stream，持有並負責停止它的 tracks。切模式或重連時，
 * 房間層用 T-106 當下最新的 stream 建立下一個傳輸。
 */
export interface HostTransport {
  /** 建立時的模式；切換模式是「拆掉重建」，不是改這個欄位。 */
  readonly mode: Mode;
  /** 建立時傳入的 T-106 stream。換片後的送出軌道由 replaceTrack 更新。 */
  readonly stream: MediaStream;

  /**
   * P2P 裝好 `onPeerRequest`、`onSignal` 並記住目前各 kind 的 track 與畫質即
   * resolve，即使尚無收看者。首次 offer 的 sender 等收到 peer:request 才建立。
   * Relay 在 WHIP 回 201 且已套用 answer 後 resolve。房間層在 `await start()`
   * 之後才送 `stream:status { live: true, title }`（目前片名）。
   */
  start(): Promise<void>;
  /** 停止傳輸但可再 start()，失敗走 onError。下一次 WHIP 發布須等舊發布清理完成。 */
  stop(): void;

  /**
   * 換片或 track 異動時，記住該 kind 最新的 track，null 表示暫時缺軌。
   * 每條 P2P 連線從首次 offer 就有 video、audio 各一個 sendonly transceiver，
   * 補軌沿用原 sender。現有與晚加入的 peer 都套用最新 tracks、畫質與縮放，
   * video track 更換時依新高度重算。
   */
  replaceTrack(kind: "video" | "audio", track: MediaStreamTrack | null): void;

  /**
   * 先記住最新編碼目標（已由房間層解析的畫質，streaming.md §2）供之後的 peer 使用，
   * 再逐一套用到現有 video sender。
   * 每個失敗的 peer 各以 onError 回報帶 memberId 的 TRACK_ERROR，其餘照常套用。
   * Relay 的單一上傳失敗時省略 memberId。
   * 全部處理完後若有失敗，Promise 以第一個 TRACK_ERROR reject。
   */
  setQuality(quality: EncodingTarget): Promise<void>;

  /**
   * 關閉該成員的連線並作廢其協商代次，包括在途建連、ICE 佇列、重試與統計。
   * 冪等（對不存在或已關閉的 memberId 呼叫是 no-op）。房間層比對
   * `room:members`，對消失或 `online: false` 的成員呼叫它（踢人、收看者離線）。
   */
  removePeer(memberId: string): void;

  onState(handler: (state: HostTransportState) => void): Unsubscribe;
  /** P2P 逐人的本地狀態，重試用盡時搭配 onError 回報，再 removePeer。 */
  onPeerState(
    handler: (peer: { memberId: string; state: MemberState }) => void,
  ): Unsubscribe;
  /**
   * 每 2 秒的上傳統計，P2P 依成員，relay 只有一份。rttMs 需有可用的
   * selectedCandidatePairId 及對應 RTT，packetLoss 取自 remote-inbound-rtp，
   * frameHeight／framesPerSecond／qualityLimitationReason 取自 video outbound-rtp。
   * 缺少資料時省略該欄位。
   */
  onStats(
    handler: (stats: TransportStats & { memberId?: string }) => void,
  ): Unsubscribe;
  onError(handler: (error: TransportError) => void): Unsubscribe;

  /** 釋放連線、監聽與計時，保留來源 tracks。銷毀後停止 UI 事件，仍須依 Location 清理 WHIP。 */
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
   * - relay：WHEP 回 201 且已套用 answer。
   * - p2p：onSignal 就緒。房間層在 auth 前備妥接收器，待此處就緒再交付暫存信令。
   * 晚加入時依 snapshot 的 stream.live 決定是否立即 start()。手動重連 P2P 時，
   * 房間層先 destroy 舊傳輸，於新 WebSocket 重新驗證以觸發 peer:request（§3）。
   * 房間層在確認直播且訂閱就緒後才計時等待首份 offer（建議 20 秒）。已緩衝的
   * offer 也算收到。收到 offer、停播、切模式、stop 或 destroy 時取消計時。
   */
  start(): Promise<void>;
  /** 停止接收但保留物件（可再 start()）；會移除 remoteStream 舊 track。 */
  stop(): void;

  onState(handler: (state: ViewerTransportState) => void): Unsubscribe;
  /** 每 2 秒的接收統計。packetLoss 取自 inbound-rtp，rttMs 取自所選 candidate-pair，各自缺值時省略。 */
  onStats(handler: (stats: TransportStats) => void): Unsubscribe;
  onError(handler: (error: TransportError) => void): Unsubscribe;

  /** 釋放連線、監聽與計時，移除遠端 tracks。銷毀後仍須依 Location 清理 WHEP。 */
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
  /** 建立這一個傳輸時從 T-106 取得的最新片源。 */
  stream: MediaStream;
  signal: TransportSignal;
  mode: Mode;
  /** 已解析的編碼目標（`resolveQuality()`，streaming.md §2）。 */
  quality: EncodingTarget;
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

/** 依 mode 選用實作（§9「匯出位置」）。 */
export const createHostTransport: CreateHostTransport = (options) =>
  options.mode === "p2p"
    ? createP2PHostTransport(options)
    : createRelayHostTransport(options);

export const createViewerTransport: CreateViewerTransport = (options) =>
  options.mode === "p2p"
    ? createP2PViewerTransport(options)
    : createRelayViewerTransport(options);
