import { describe, expect, it } from "vitest";
import {
  computeTransportStats,
  estimateTotalUploadBitrate,
  shouldWarnTotalUpload,
  StatsSampler,
  type StatsEntry,
} from "./stats";

function entry(type: string, fields: Record<string, unknown>): StatsEntry {
  return { type, id: `${type}-1`, timestamp: 1000, ...fields };
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
  it("computes bitrate from the bytes delta over time", () => {
    const result = computeTransportStats(
      [entry("outbound-rtp", { bytesSent: 2000 })],
      2000,
      { bytes: 1000, timestamp: 1000 },
    );
    expect(result.stats.bitrateKbps).toBe(8);
    expect(result.bytes).toBe(2000);
  });

  it("extracts RTT from a succeeded candidate pair", () => {
    const result = computeTransportStats(
      [
        entry("candidate-pair", {
          state: "succeeded",
          currentRoundTripTime: 0.05,
        }),
      ],
      1000,
    );
    expect(result.stats.rttMs).toBe(50);
  });

  it("computes the packet loss ratio", () => {
    const result = computeTransportStats(
      [entry("inbound-rtp", { packetsLost: 1, packetsReceived: 9 })],
      1000,
    );
    expect(result.stats.packetLoss).toBeCloseTo(0.1);
  });

  it("returns zero bitrate on the first sample", () => {
    const result = computeTransportStats(
      [entry("outbound-rtp", { bytesSent: 1000 })],
      1000,
    );
    expect(result.stats.bitrateKbps).toBe(0);
    expect(result.bytes).toBe(1000);
  });
});

describe("StatsSampler", () => {
  it("keeps the previous bytes across samples", async () => {
    let bytes = 1000;
    let now = 1000;
    const sampler = new StatsSampler(
      async () => [entry("outbound-rtp", { bytesSent: bytes })],
      () => now,
    );

    expect((await sampler.sample()).bitrateKbps).toBe(0);

    bytes = 2000;
    now = 2000;
    expect((await sampler.sample()).bitrateKbps).toBe(8);
  });
});
