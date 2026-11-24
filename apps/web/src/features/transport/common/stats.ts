/**
 * 連線統計與頻寬預估（docs/specs/streaming.md §2、§8）。
 */
import {
  P2P_TOTAL_BITRATE_WARNING,
  QUALITY_PRESETS,
  type Quality,
} from "@project/shared";

/** 單條連線的統計。 */
export interface TransportStats {
  /** 送出（房主）或收到（收看者）的碼率（kbps）。 */
  bitrateKbps: number;
  /** 單趟延遲（RTT，毫秒）；有的連線才會有。 */
  rttMs?: number;
  /** 封包遺失率 0–1。 */
  packetLoss?: number;
}

/** getStats() 的單一項目（最小結構，方便在 Node 測試環境造資料）。 */
export interface StatsEntry {
  type: string;
  id: string;
  timestamp: number;
  [key: string]: unknown;
}

/** 開播前總上傳量預估（bps）：P2P 每條連線都要上傳一份。streaming.md §2。 */
export function estimateTotalUploadBitrate(
  quality: Quality,
  viewerCount: number,
): number {
  return QUALITY_PRESETS[quality].maxBitrate * viewerCount;
}

/** 總上傳量超過 60 Mbps 時提示房主改用「流暢」或「轉發」（不強制）。streaming.md §2。 */
export function shouldWarnTotalUpload(
  quality: Quality,
  viewerCount: number,
): boolean {
  return (
    estimateTotalUploadBitrate(quality, viewerCount) > P2P_TOTAL_BITRATE_WARNING
  );
}

/**
 * 從 getStats() 項目算出統計。`now` 與 `previous` 用來算碼率（兩個取樣之間的
 * bytes 差），rtt 與封包遺失是取樣當下的值。
 *
 * 回傳 `bytes` 是本次觀察到的累計 bytes（bytesSent 或 bytesReceived），
 * 呼叫端存起來當下次的 `previous`。
 */
export function computeTransportStats(
  entries: Iterable<StatsEntry>,
  now: number,
  previous?: { bytes: number; timestamp: number },
): { stats: TransportStats; bytes?: number } {
  let rttMs: number | undefined;
  let bytes: number | undefined;
  let packetsLost: number | undefined;
  let packetsReceived: number | undefined;

  for (const entry of entries) {
    if (entry.type === "candidate-pair" && entry.state === "succeeded") {
      const rttSeconds = asFiniteNumber(entry.currentRoundTripTime);
      if (rttSeconds !== undefined) rttMs = rttSeconds * 1000;
    } else if (entry.type === "outbound-rtp" || entry.type === "inbound-rtp") {
      bytes =
        asFiniteNumber(entry.bytesSent) ??
        asFiniteNumber(entry.bytesReceived) ??
        bytes;
      packetsLost = asFiniteNumber(entry.packetsLost) ?? packetsLost;
      packetsReceived =
        asFiniteNumber(entry.packetsReceived) ?? packetsReceived;
    }
  }

  let bitrateKbps = 0;
  if (
    bytes !== undefined &&
    previous !== undefined &&
    previous.bytes !== undefined
  ) {
    const deltaBytes = Math.max(0, bytes - previous.bytes);
    const deltaMs = now - previous.timestamp;
    if (deltaMs > 0) bitrateKbps = (deltaBytes * 8) / deltaMs;
  }

  let packetLoss: number | undefined;
  const totalPackets = (packetsLost ?? 0) + (packetsReceived ?? 0);
  if (packetsLost !== undefined && totalPackets > 0) {
    packetLoss = packetsLost / totalPackets;
  }

  const stats: TransportStats = { bitrateKbps };
  if (rttMs !== undefined) stats.rttMs = rttMs;
  if (packetLoss !== undefined) stats.packetLoss = packetLoss;
  return { stats, bytes };
}

/**
 * 定期取樣器：持有上一次的 bytes 與時間，算出碼率。
 * 建構時注入 `getStats`（通常是 `() => pc.getStats()`）與 `now`（測試用假時鐘）。
 */
export class StatsSampler {
  private previous: { bytes: number; timestamp: number } | undefined;

  constructor(
    private readonly getStats: () => Promise<Iterable<StatsEntry>>,
    private readonly now: () => number = Date.now,
  ) {}

  async sample(): Promise<TransportStats> {
    const entries = await this.getStats();
    const timestamp = this.now();
    const result = computeTransportStats(entries, timestamp, this.previous);
    if (result.bytes !== undefined) {
      this.previous = { bytes: result.bytes, timestamp };
    }
    return result.stats;
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
