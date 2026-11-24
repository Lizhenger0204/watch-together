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
  const transport = list.find((entry) => entry.type === "transport");
  const selectedCandidatePairId = asString(transport?.selectedCandidatePairId);
  let rttMs: number | undefined;
  const selectedPair =
    selectedCandidatePairId !== undefined
      ? list.find(
          (entry) =>
            entry.type === "candidate-pair" &&
            entry.id === selectedCandidatePairId &&
            entry.state === "succeeded",
        )
      : list.find(
          (entry) =>
            entry.type === "candidate-pair" && entry.state === "succeeded",
        );
  if (selectedPair) {
    const rtt = asFiniteNumber(selectedPair.currentRoundTripTime);
    if (rtt !== undefined) rttMs = rtt * 1000;
  }

  // 依方向加總 bytes 與封包（影音各一條 RTP stream）。
  const rtpType = direction === "send" ? "outbound-rtp" : "inbound-rtp";
  const bytesByRtp = new Map<string, number>();
  let packetsLost = 0;
  let packetsReceived = 0;
  for (const entry of list) {
    if (entry.type !== rtpType) continue;
    const bytes = asFiniteNumber(
      direction === "send" ? entry.bytesSent : entry.bytesReceived,
    );
    if (bytes !== undefined) bytesByRtp.set(entry.id, bytes);

    const lost = asFiniteNumber(entry.packetsLost);
    if (lost !== undefined) packetsLost += Math.max(0, lost);
    const received = asFiniteNumber(entry.packetsReceived);
    if (received !== undefined) packetsReceived += Math.max(0, received);
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

  const totalPackets = packetsReceived + packetsLost;
  let packetLoss: number | undefined;
  if (totalPackets > 0) {
    packetLoss = Math.min(1, Math.max(0, packetsLost / totalPackets));
  }

  const stats: TransportStats = { bitrateKbps };
  if (rttMs !== undefined) stats.rttMs = rttMs;
  if (packetLoss !== undefined) stats.packetLoss = packetLoss;
  return { stats, snapshot: { bytesByRtp, timestamp: now } };
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
