/** relay 房主與收看者共用：取 ICE、產生單次 HTTP offer、統計取樣。 */
import type { TransportRtcOptions } from "../index";
import {
  browserPeerConnectionFactory,
  fetchIceServers,
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
  let iceServers: RTCIceServer[];
  try {
    iceServers = await (options.fetchIceServers
      ? options.fetchIceServers()
      : fetchIceServers(options.roomId, options.token, { signal }));
  } catch (error) {
    throw error instanceof TransportError
      ? error
      : new TransportError("ICE_UNAVAILABLE", "無法取得 ICE 設定", {
          cause: error,
        });
  }
  if (signal.aborted) return null;
  return (options.createPeerConnection ?? browserPeerConnectionFactory)({
    iceServers,
  });
}

/**
 * §4：先 setLocalDescription(offer)，再有界等 ICE 收集，重新讀取 localDescription，
 * 整份 SDP（含已收集的 candidates）作為 POST body。已取消或沒有有效 offer 回 null。
 */
export async function gatheredOffer(
  pc: RtcPeerConnection,
  signal: AbortSignal,
): Promise<string | null> {
  const offer = await pc.createOffer();
  if (signal.aborted) return null;
  await pc.setLocalDescription(offer);
  if (signal.aborted) return null;
  await pc.waitForIceGatheringComplete(ICE_GATHERING_TIMEOUT_MS);
  if (signal.aborted) return null;
  const local = pc.localDescription;
  return local?.type === "offer" ? local.sdp : null;
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

export function isIceConnected(pc: RtcPeerConnection) {
  return (
    pc.iceConnectionState === "connected" ||
    pc.iceConnectionState === "completed"
  );
}

export function closePeerConnection(pc: RtcPeerConnection | undefined) {
  if (!pc) return;
  pc.ontrack = null;
  pc.onicecandidate = null;
  pc.oniceconnectionstatechange = null;
  pc.onconnectionstatechange = null;
  pc.close();
}

export function relayError(cause: unknown, message: string) {
  return cause instanceof TransportError
    ? cause
    : new TransportError("RELAY_FAILED", message, { cause });
}
