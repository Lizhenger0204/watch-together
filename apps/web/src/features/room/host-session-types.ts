import type { ClientMessageOf, Member, ServerMessage } from "@project/shared";
import { ApiError } from "../../lib/api";
import {
  SignalDisconnectedError,
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

export type HostRequest =
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
  /** 房主明確按「停止直播」時呼叫（由 hook 讓其他分頁保存的開播意圖一併失效）。 */
  onExplicitStop?: () => void;
  /** 每次重新驗證時確認分頁保存的意圖仍有效（另一分頁明確停播後回 false）。 */
  intentStillValid?: () => boolean;
  createTransport?: CreateHostTransport;
  /** 逾時等計時器（預設瀏覽器 timers）。 */
  timers?: SessionTimers;
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
