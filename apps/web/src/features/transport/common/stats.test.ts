import { describe, expect, it } from "vitest";
import {
  computeTransportStats,
  estimateTotalUploadBitrate,
  shouldWarnTotalUpload,
  StatsSampler,
  type StatsEntry,
} from "./stats";

function entry(
  type: string,
  id: string,
  fields: Record<string, unknown>,
): StatsEntry {
  return { type, id, timestamp: 1000, ...fields };
}

describe("estimateTotalUploadBitrate", () => {
  it("multiplies the preset bitrate by the viewer count", () => {
    expect(estimateTotalUploadBitrate("standard", 3)).toBe(18_000_000);
    expect(estimateTotalUploadBitrate("smooth", 7)).toBe(21_000_000);
    expect(estimateTotalUploadBitrate("high", 0)).toBe(0);
  });
});

describe("shouldWarnTotalUpload", () => {
  it("warns only above 60 Mbps", () => {
    expect(shouldWarnTotalUpload("high", 7)).toBe(false); // 56 Mbps
    expect(shouldWarnTotalUpload("high", 8)).toBe(true); // 64 Mbps
  });
});

describe("computeTransportStats", () => {
  it("sums bytes across video and audio RTP streams", () => {
    const entries = [
      entry("outbound-rtp", "rtp-v", { bytesSent: 800 }),
      entry("outbound-rtp", "rtp-a", { bytesSent: 16 }),
    ];
    const previous = {
      bytesByRtp: new Map([
        ["rtp-v", 0],
        ["rtp-a", 0],
      ]),
      timestamp: 0,
    };
    const result = computeTransportStats(entries, "send", 1000, previous);
    // (800 + 16) bytes × 8 / 1000 ms = 6.528 kbps
    expect(result.stats.bitrateKbps).toBeCloseTo(6.528);
  });

  it("returns zero bitrate on the first sample", () => {
    const entries = [entry("outbound-rtp", "rtp-v", { bytesSent: 1000 })];
    const result = computeTransportStats(entries, "send", 1000);
    expect(result.stats.bitrateKbps).toBe(0);
    expect(result.snapshot.bytesByRtp.get("rtp-v")).toBe(1000);
  });

  it("extracts RTT via selectedCandidatePairId", () => {
    const entries = [
      entry("transport", "t1", { selectedCandidatePairId: "cp-2" }),
      entry("candidate-pair", "cp-1", {
        state: "succeeded",
        currentRoundTripTime: 0.01,
      }),
      entry("candidate-pair", "cp-2", {
        state: "succeeded",
        currentRoundTripTime: 0.05,
      }),
    ];
    const result = computeTransportStats(entries, "receive", 1000);
    expect(result.stats.rttMs).toBe(50);
  });

  it("falls back to the first succeeded candidate-pair without selectedCandidatePairId", () => {
    const entries = [
      entry("candidate-pair", "cp-1", {
        state: "succeeded",
        currentRoundTripTime: 0.03,
      }),
    ];
    const result = computeTransportStats(entries, "receive", 1000);
    expect(result.stats.rttMs).toBe(30);
  });

  it("clamps negative packet loss to 0", () => {
    const entries = [
      entry("inbound-rtp", "rtp-v", {
        bytesReceived: 1000,
        packetsLost: -3,
        packetsReceived: 10,
      }),
    ];
    const result = computeTransportStats(entries, "receive", 1000);
    expect(result.stats.packetLoss).toBe(0);
  });

  it("computes the packet loss ratio", () => {
    const entries = [
      entry("inbound-rtp", "rtp-v", {
        bytesReceived: 1000,
        packetsLost: 1,
        packetsReceived: 9,
      }),
    ];
    const result = computeTransportStats(entries, "receive", 1000);
    expect(result.stats.packetLoss).toBeCloseTo(0.1);
  });
});

describe("StatsSampler", () => {
  it("keeps the previous bytes across samples", async () => {
    let bytes = 1000;
    let now = 1000;
    const report = () =>
      new Map<string, StatsEntry>([
        [
          "rtp-v",
          {
            type: "outbound-rtp",
            id: "rtp-v",
            timestamp: now,
            bytesSent: bytes,
          },
        ],
      ]) as unknown as RTCStatsReport;

    const sampler = new StatsSampler(
      async () => report(),
      "send",
      () => now,
    );

    expect((await sampler.sample()).bitrateKbps).toBe(0);

    bytes = 2000;
    now = 2000;
    expect((await sampler.sample()).bitrateKbps).toBe(8);
  });
});
