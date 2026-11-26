/**
 * 連線統計與頻寬預估（docs/specs/streaming.md §2、§8）。
 *
 * 統計的取法（見 streaming.md §8）：
 * - 碼率：依方向（host 用 bytesSent、viewer 用 bytesReceived）對每個 RTP id
 *   算兩次取樣之間的 bytes 差，再**加總**（影音各一條 RTP stream）。
 * - RTT：先找 `transport` 的 `selectedCandidatePairId`，再取該 candidate-pair 的
 *   `currentRoundTripTime`。
 * - 封包遺失：`packetsLost` 夾到 ≥ 0，遺失率夾到 0～1。
 */
import { P2P_TOTAL_BITRATE_WARNING } from "@project/shared";

/** 房主端 video outbound-rtp 的編碼品質限制原因（streaming.md §8）。 */
export type QualityLimitationReason = "none" | "cpu" | "bandwidth" | "other";

const QUALITY_LIMITATION_REASONS = new Set<QualityLimitationReason>([
  "none",
  "cpu",
  "bandwidth",
  "other",
]);

/** 單條連線的統計。 */
export interface TransportStats {
  /** 送出（房主）或收到（收看者）的碼率（kbps）。 */
  bitrateKbps: number;
  /** 往返延遲（RTT，毫秒）。 */
  rttMs?: number;
  /** 封包遺失率 0–1。 */
  packetLoss?: number;
  /** 以下只在房主方向（"send"）提供，來源見 streaming.md §8；收看者不送進 member:status。 */
  frameHeight?: number;
  framesPerSecond?: number;
  qualityLimitationReason?: QualityLimitationReason;
}

/** 取樣方向：房主送出（bytesSent）、收看者收到（bytesReceived）。 */
export type StatsDirection = "send" | "receive";

/** getStats() 的單一項目（最小結構，方便在 Node 測試環境造資料）。 */
export interface StatsEntry {
  type: string;
  id: string;
  timestamp: number;
  [key: string]: unknown;
}

/** 上次取樣留下的快照，用來算碼率。 */
export interface StatsSnapshot {
  bytesByRtp: Map<string, number>;
  timestamp: number;
}

/**
 * 總上傳量預估（bps）：P2P 每條連線都要上傳一份。streaming.md §2。
 * `bitrate` 是每人的實際位元率（`EncodingTarget.maxBitrate`）。
 */
export function estimateTotalUploadBitrate(
  bitrate: number,
  viewerCount: number,
): number {
  return bitrate * viewerCount;
}

/** 總上傳量超過 60 Mbps 時提示房主調低位元率或改用「轉發」（不強制）。streaming.md §2。 */
export function shouldWarnTotalUpload(
  bitrate: number,
  viewerCount: number,
): boolean {
  return (
    estimateTotalUploadBitrate(bitrate, viewerCount) > P2P_TOTAL_BITRATE_WARNING
  );
}

function computePacketLoss(
  entries: StatsEntry[],
  direction: StatsDirection,
): number | undefined {
  const type = direction === "send" ? "remote-inbound-rtp" : "inbound-rtp";
  const receivers = entries.filter((entry) => entry.type === type);
  if (direction === "send") {
    // RTCP fractionLost 是最近回報區間的比例；避免混入其他串流的累計計數。
    const fractions = receivers
      .map((entry) => asFiniteNumber(entry.fractionLost))
      .filter((fraction) => fraction !== undefined);
    if (fractions.length > 0) {
      const sum = fractions.reduce(
        (total, fraction) => total + Math.min(1, Math.max(0, fraction)),
        0,
      );
      return sum / fractions.length;
    }
  }

  let packetsLost = 0;
  let totalPackets = 0;
  for (const receiver of receivers) {
    const reportedLoss = asFiniteNumber(receiver.packetsLost);
    if (reportedLoss === undefined) continue;
    const lost = Math.max(0, reportedLoss);
    const received = asFiniteNumber(receiver.packetsReceived);
    let total: number | undefined;
    if (received !== undefined) {
      total = Math.max(0, received) + lost;
    } else if (direction === "send") {
      // 有些遠端回報只有遺失數，分母必須取自同一條 outbound RTP。
      const outbound = entries.find(
        (entry) =>
          entry.type === "outbound-rtp" &&
          (entry.id === receiver.localId || entry.remoteId === receiver.id),
      );
      total = asFiniteNumber(outbound?.packetsSent);
    }
    if (total === undefined || total <= 0) continue;
    packetsLost += Math.min(lost, total);
    totalPackets += total;
  }
  return totalPackets > 0 ? packetsLost / totalPackets : undefined;
}

/**
 * 從 getStats() 項目算出統計。
 * `previous` 是上一次取樣留下的 `snapshot`（第一次可省略，此時碼率為 0）。
 */
export function computeTransportStats(
  entries: Iterable<StatsEntry>,
  direction: StatsDirection,
  now: number,
  previous?: StatsSnapshot,
): { stats: TransportStats; snapshot: StatsSnapshot } {
  const list = [...entries];

  // RTT：依 selectedCandidatePairId 找 selected 的 candidate-pair。
  const selectedPairIds = new Set(
    list
      .filter((entry) => entry.type === "transport")
      .map((entry) => entry.selectedCandidatePairId)
      .filter((id) => typeof id === "string" && id !== ""),
  );
  const rttSeconds = list
    .filter(
      (entry) =>
        entry.type === "candidate-pair" && selectedPairIds.has(entry.id),
    )
    .map((pair) => asFiniteNumber(pair.currentRoundTripTime))
    .find((rtt) => rtt !== undefined);

  // 依方向加總 bytes（影音各一條 RTP stream）。
  const rtpType = direction === "send" ? "outbound-rtp" : "inbound-rtp";
  const bytesByRtp = new Map<string, number>();
  for (const entry of list) {
    if (entry.type !== rtpType) continue;
    const bytes = asFiniteNumber(
      direction === "send" ? entry.bytesSent : entry.bytesReceived,
    );
    if (bytes !== undefined) bytesByRtp.set(entry.id, bytes);
  }

  let bitrateKbps = 0;
  if (previous) {
    const deltaMs = now - previous.timestamp;
    if (deltaMs > 0) {
      let deltaBytes = 0;
      for (const [id, bytes] of bytesByRtp) {
        const prev = previous.bytesByRtp.get(id);
        if (prev !== undefined) deltaBytes += Math.max(0, bytes - prev);
      }
      bitrateKbps = (deltaBytes * 8) / deltaMs;
    }
  }

  const packetLoss = computePacketLoss(list, direction);
  const stats: TransportStats = { bitrateKbps };
  if (rttSeconds !== undefined) stats.rttMs = rttSeconds * 1000;
  if (packetLoss !== undefined) stats.packetLoss = packetLoss;
  if (direction === "send") {
    const video = pickOutboundVideo(list);
    if (video) {
      const frameHeight = asNonNegativeNumber(video.frameHeight);
      const framesPerSecond = asNonNegativeNumber(video.framesPerSecond);
      const reason = asQualityLimitationReason(video.qualityLimitationReason);
      if (frameHeight !== undefined) stats.frameHeight = frameHeight;
      if (framesPerSecond !== undefined)
        stats.framesPerSecond = framesPerSecond;
      if (reason !== undefined) stats.qualityLimitationReason = reason;
    }
  }
  return { stats, snapshot: { bytesByRtp, timestamp: now } };
}

/**
 * 房主方向取 video `outbound-rtp`（streaming.md §8）。
 * 同一 sender 有多個 video `outbound-rtp` 時取 `frameHeight` 最大者。
 */
function pickOutboundVideo(entries: StatsEntry[]): StatsEntry | undefined {
  let chosen: StatsEntry | undefined;
  let maxHeight = -1;
  for (const entry of entries) {
    if (entry.type !== "outbound-rtp") continue;
    const kind = entry.kind ?? entry.mediaType;
    if (kind !== "video") continue;
    const height = asNonNegativeNumber(entry.frameHeight) ?? -1;
    if (chosen === undefined || height > maxHeight) {
      chosen = entry;
      maxHeight = height;
    }
  }
  return chosen;
}

/**
 * 定期取樣器：持有上一次的快照，算出碼率。
 * 建構時注入 `getStats`（`() => pc.getStats()`）、方向與 `now`（測試用假時鐘）。
 */
export class StatsSampler {
  private previous: StatsSnapshot | undefined;

  constructor(
    private readonly getStats: () => Promise<RTCStatsReport>,
    private readonly direction: StatsDirection,
    private readonly now: () => number = Date.now,
  ) {}

  async sample(): Promise<TransportStats> {
    const report = await this.getStats();
    const entries = [...report.values()] as unknown as StatsEntry[];
    const timestamp = this.now();
    const result = computeTransportStats(
      entries,
      this.direction,
      timestamp,
      this.previous,
    );
    this.previous = result.snapshot;
    return result.stats;
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function asQualityLimitationReason(
  value: unknown,
): QualityLimitationReason | undefined {
  return typeof value === "string" &&
    QUALITY_LIMITATION_REASONS.has(value as QualityLimitationReason)
    ? (value as QualityLimitationReason)
    : undefined;
}
