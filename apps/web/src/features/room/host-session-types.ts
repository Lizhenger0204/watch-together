import type {
  ClientMessageOf,
  Member,
  Quality,
  ServerMessage,
} from "@project/shared";
import { ApiError } from "../../lib/api";
import {
  SignalDisconnectedError,
  SignalTimeoutError,
  type ConnectionState,
} from "../../lib/signal";
import { TransportError, type CreateHostTransport } from "../transport";
import type { SessionTimers } from "./viewer-session";

/** useLocalSource 的片源狀態（check.status 原樣傳入）。 */
export type HostSource = {
  stream: MediaStream | null;
  status: "idle" | "checking" | "ready" | "warning" | "error";
  /** 去掉副檔名的檔名；送出前用 live-intent.ts 的 streamTitle 截斷。 */
  title: string;
  /** 估計的原片位元率（bps，streaming.md §2「原片位元率」）；量不到為 null。 */
  bitrate: number | null;
};

export type HostPhase =
  /** 沒有開播意圖。 */
  | "idle"
  /** 有開播意圖，但暫時不能開播（未連線、等待重新同步、片源未就緒）。UI 顯示「直播暫停中」。 */
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
  /** 房主最後一次選的畫質檔位，還沒被房間廣播追上（畫質面板顯示它而不是舊廣播值）；沒有為 null。 */
  pendingQuality: Quality | null;
  /** 直播中房主編碼器連續 10 秒跟不上（streaming.md §2「高畫質提示」）。 */
  encoderLagging: boolean;
  /** Safari 模式（streaming.md §2）：只在房主本機生效，預設關閉。 */
  safariMode: boolean;
};

/** 兩份畫面狀態的每個欄位都相同（欄位都是基本值或同一個物件參照）。 */
export function sameHostView(a: HostSessionView, b: HostSessionView): boolean {
  return (Object.keys(a) as (keyof HostSessionView)[]).every(
    (key) => a[key] === b[key],
  );
}

export type HostRequest =
  | Omit<ClientMessageOf<"stream:status">, "reqId">
  | Omit<ClientMessageOf<"room:update">, "reqId">;

/** SignalClient 的子集（測試注入 fake）。 */
export interface HostSessionClient {
  onMessage(handler: (message: ServerMessage) => void): () => void;
  onState(handler: (state: ConnectionState) => void): () => void;
  send(message: ClientMessageOf<"signal">): boolean;
  /** 等同一 reqId 的 ack；失敗以 ApiError（斷線為 SignalDisconnectedError、逾時為 SignalTimeoutError）reject。 */
  request(message: HostRequest): Promise<void>;
  /** 關閉目前連線並建立新連線重新驗證，以取得最新 room:snapshot。 */
  resync(): void;
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
  /** 房主明確按「停止直播」時呼叫（由 hook 讓其他分頁保存的開播意圖一併失效）。 */
  onExplicitStop?: () => void;
  /** 每次重新驗證時確認分頁保存的意圖仍有效（另一分頁明確停播後回 false）。 */
  intentStillValid?: () => boolean;
  createTransport?: CreateHostTransport;
  /** 逾時等計時器（預設瀏覽器 timers）。 */
  timers?: SessionTimers;
  /** 目前時間（預設 Date.now，測試用假時鐘）。 */
  now?: () => number;
};

export type Kind = "video" | "audio";
export type Tracks = Record<Kind, MediaStreamTrack | null>;
export type Op = "starting" | "stopping" | "switching";

export const KINDS: Kind[] = ["video", "audio"];
export const NO_TRACKS: Tracks = { video: null, audio: null };

/** 和 P2P host 的 start() 一樣：各 kind 取第一條還沒結束的 track。 */
export function tracksOf(stream: MediaStream | null): Tracks {
  if (!stream) return NO_TRACKS;
  const pick = (list: MediaStreamTrack[]) =>
    list.find((track) => track.readyState !== "ended") ?? null;
  return {
    video: pick(stream.getVideoTracks()),
    audio: pick(stream.getAudioTracks()),
  };
}

export function onlineViewers(members: Member[]) {
  return new Set(
    members
      .filter((m) => m.role === "member" && m.online)
      .map((m) => m.memberId),
  );
}

export const disconnected = (error: unknown) =>
  error instanceof SignalDisconnectedError;

export const timedOut = (error: unknown) => error instanceof SignalTimeoutError;

export function readable(error: unknown): string {
  if (error instanceof TransportError || error instanceof ApiError) {
    return error.message;
  }
  return "操作失敗，請稍後再試。";
}

export const browserTimers: SessionTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as number),
};
