/** relay 房主與收看者共用：取 ICE、產生單次 HTTP offer、統計取樣。 */
import type { TransportRtcOptions } from "../index";
import {
  browserPeerConnectionFactory,
  loadIceServers,
  StatsSampler,
  TransportError,
  type RtcPeerConnection,
  type StatsDirection,
  type TransportStats,
} from "../common";
import { ICE_GATHERING_TIMEOUT_MS } from "./http";

const STATS_INTERVAL_MS = 2_000;

export type ConnectionOptions = TransportRtcOptions & {
  roomId: string;
  token: string;
};

/** 每次建連線前取 ICE（TURN 憑證短效，不快取）後建立連線。 */
export async function openPeerConnection(
  options: ConnectionOptions,
  signal: AbortSignal,
): Promise<RtcPeerConnection | null> {
  const iceServers = await loadIceServers(options, signal);
  if (signal.aborted) return null;
  return (options.createPeerConnection ?? browserPeerConnectionFactory)({
    iceServers,
  });
}

const offerError = (cause?: unknown) =>
  new TransportError("RELAY_FAILED", "無法產生連線提議（offer）", { cause });

/** 包裝層遇到空 SDP 丟 SIGNAL_ERROR（common/rtc.ts）；轉發沒有信令，改回 RELAY_FAILED。 */
async function readOffer<T>(read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof TransportError && error.code === "SIGNAL_ERROR")
      throw offerError(error);
    throw error;
  }
}

/**
 * §4：先 setLocalDescription(offer)，再有界等 ICE 收集，重新讀取 localDescription，
 * 整份 SDP（含已收集的 candidates）作為 POST body。
 * 已取消回 null（呼叫端安靜結束）；沒有有效 offer 丟 RELAY_FAILED（呼叫端清理並回報）。
 */
export async function gatheredOffer(
  pc: RtcPeerConnection,
  signal: AbortSignal,
): Promise<string | null> {
  const offer = await readOffer(() => pc.createOffer());
  if (signal.aborted) return null;
  await pc.setLocalDescription(offer);
  if (signal.aborted) return null;
  await pc.waitForIceGatheringComplete(ICE_GATHERING_TIMEOUT_MS);
  if (signal.aborted) return null;
  const local = await readOffer(() => pc.localDescription);
  if (local?.type !== "offer" || !local.sdp) throw offerError();
  return local.sdp;
}

/** 每 2 秒取樣一次，直到 signal 中止。取樣失敗略過這一次。 */
export function sampleStats(
  pc: RtcPeerConnection,
  direction: StatsDirection,
  signal: AbortSignal,
  onStats: (stats: TransportStats) => void,
) {
  const sampler = new StatsSampler(() => pc.getStats(), direction);
  let sampling = false;
  const timer = setInterval(() => {
    if (signal.aborted || sampling) return;
    sampling = true;
    sampler
      .sample()
      .then((stats) => {
        if (!signal.aborted) onStats(stats);
      })
      .catch(() => {})
      .finally(() => {
        sampling = false;
      });
  }, STATS_INTERVAL_MS);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

export function closePeerConnection(pc: RtcPeerConnection | undefined) {
  if (!pc) return;
  pc.ontrack = null;
  pc.onicecandidate = null;
  pc.oniceconnectionstatechange = null;
  pc.onconnectionstatechange = null;
  pc.close();
}

/**
 * 停止時讓 start() 立刻結束：不等已關閉連線上的原生 RTC 操作（可能永遠不 resolve）。
 * 背景的 work 照常跑到下一個檢查點自行收尾，它之後的結果不再影響 start()。
 */
export function untilStopped<T>(work: Promise<T>, signal: AbortSignal) {
  const stopped = new Promise<never>((_, reject) => {
    const abort = () =>
      reject(new TransportError("RELAY_FAILED", "轉發已停止"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([work, stopped]);
}

export function relayError(cause: unknown, message: string) {
  return cause instanceof TransportError
    ? cause
    : new TransportError("RELAY_FAILED", message, { cause });
}
