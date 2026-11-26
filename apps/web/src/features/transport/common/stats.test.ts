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
  it("multiplies the per-viewer bitrate by the viewer count", () => {
    expect(estimateTotalUploadBitrate(8_000_000, 3)).toBe(24_000_000);
    expect(estimateTotalUploadBitrate(10_000_000, 7)).toBe(70_000_000);
    expect(estimateTotalUploadBitrate(15_000_000, 0)).toBe(0);
  });
});

describe("shouldWarnTotalUpload", () => {
  it("warns only above 60 Mbps", () => {
    expect(shouldWarnTotalUpload(8_000_000, 7)).toBe(false); // 56 Mbps
    expect(shouldWarnTotalUpload(8_000_000, 8)).toBe(true); // 64 Mbps
    expect(shouldWarnTotalUpload(15_000_000, 4)).toBe(false); // 60 Mbps
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
      entry("transport", "starting", {}),
      entry("transport", "t1", { selectedCandidatePairId: "cp-2" }),
      entry("candidate-pair", "cp-1", {
        state: "succeeded",
        currentRoundTripTime: 0.01,
      }),
      entry("candidate-pair", "cp-2", {
        currentRoundTripTime: 0.05,
      }),
    ];
    const result = computeTransportStats(entries, "receive", 1000);
    expect(result.stats.rttMs).toBe(50);
  });

  it.each([undefined, "missing-pair", "no-rtt"])(
    "omits RTT for an unresolved selected pair (%s)",
    (id) => {
      const entries = [
        entry("transport", "t1", { selectedCandidatePairId: id }),
        entry("candidate-pair", "no-rtt", { state: "succeeded" }),
        entry("candidate-pair", "cp-1", {
          state: "succeeded",
          currentRoundTripTime: 0.03,
        }),
      ];
      const result = computeTransportStats(entries, "receive", 1000);
      expect(result.stats).not.toHaveProperty("rttMs");
    },
  );

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

  it("computes receive loss from the summed inbound counts", () => {
    const entries = [
      entry("inbound-rtp", "rtp-v", {
        bytesReceived: 1000,
        packetsLost: 1,
        packetsReceived: 9,
      }),
      entry("inbound-rtp", "rtp-a", { packetsLost: 1, packetsReceived: 29 }),
      entry("remote-inbound-rtp", "other", { fractionLost: 1 }),
    ];
    const result = computeTransportStats(entries, "receive", 1000);
    expect(result.stats.packetLoss).toBeCloseTo(2 / 40);
  });

  it.each([
    [0.25, 0.25],
    [-0.1, 0],
    [1.2, 1],
  ])(
    "prefers the remote receiver's fractionLost (%s) for send loss",
    (fractionLost, expected) => {
      const entries = [
        entry("inbound-rtp", "other", { packetsLost: 5, packetsReceived: 5 }),
        entry("remote-inbound-rtp", "remote-v", {
          fractionLost,
          packetsLost: 0,
          packetsReceived: 100,
        }),
      ];
      expect(
        computeTransportStats(entries, "send", 1000).stats.packetLoss,
      ).toBe(expected);
    },
  );

  it("derives send loss from remote counts and the linked outbound RTP when needed", () => {
    const entries = [
      entry("outbound-rtp", "unrelated", { packetsSent: 1000 }),
      entry("remote-inbound-rtp", "remote-v", {
        localId: "video",
        packetsLost: 3,
      }),
      entry("outbound-rtp", "video", { packetsSent: 25 }),
      entry("remote-inbound-rtp", "remote-a", {
        packetsLost: 1,
        packetsReceived: 74,
      }),
    ];
    expect(
      computeTransportStats(entries, "send", 1000).stats.packetLoss,
    ).toBeCloseTo(4 / 100);
  });

  it("averages the available remote loss fractions across media", () => {
    const entries = [
      entry("remote-inbound-rtp", "video", { fractionLost: 0.5 }),
      entry("remote-inbound-rtp", "audio", { fractionLost: 0 }),
    ];
    expect(computeTransportStats(entries, "send", 1000).stats.packetLoss).toBe(
      0.25,
    );
  });

  it("omits loss when receiver reports lack usable measurements", () => {
    const entries = [
      entry("remote-inbound-rtp", "remote-a", {
        fractionLost: NaN,
        packetsLost: 5,
      }),
      entry("outbound-rtp", "unrelated", { packetsSent: 999 }),
      entry("inbound-rtp", "audio", { packetsReceived: 25 }),
      entry("inbound-rtp", "video", { packetsLost: 3 }),
    ];
    expect(
      computeTransportStats(entries, "send", 1000).stats,
    ).not.toHaveProperty("packetLoss");
    expect(
      computeTransportStats(entries, "receive", 1000).stats,
    ).not.toHaveProperty("packetLoss");
  });

  it("uses only comparable RTP ids and bytes for the sampled direction", () => {
    const first = [
      entry("outbound-rtp", "v", { bytesSent: 1000 }),
      entry("outbound-rtp", "a", { bytesSent: 5000 }),
      entry("inbound-rtp", "recv", { bytesReceived: 3000 }),
    ];
    const second = [
      entry("outbound-rtp", "v", { bytesSent: 1800 }),
      entry("outbound-rtp", "a", { bytesSent: 10 }),
      entry("outbound-rtp", "new", { bytesSent: 9000 }),
      entry("inbound-rtp", "recv", { bytesReceived: 3100 }),
    ];
    const send = computeTransportStats(first, "send", 1000);
    const receive = computeTransportStats(first, "receive", 1000);
    expect(
      computeTransportStats(second, "send", 2000, send.snapshot).stats
        .bitrateKbps,
    ).toBeCloseTo(6.4);
    expect(
      computeTransportStats(second, "receive", 2000, receive.snapshot).stats
        .bitrateKbps,
    ).toBeCloseTo(0.8);
  });

  it("extracts video outbound-rtp height, fps and qualityLimitationReason for send direction", () => {
    const entries = [
      entry("outbound-rtp", "audio", {
        kind: "audio",
        bytesSent: 500,
        frameHeight: 9999,
        framesPerSecond: 99,
        qualityLimitationReason: "cpu",
      }),
      entry("outbound-rtp", "video-low", {
        kind: "video",
        bytesSent: 1000,
        frameHeight: 720,
        framesPerSecond: 30,
        qualityLimitationReason: "none",
      }),
      entry("outbound-rtp", "video-high", {
        kind: "video",
        bytesSent: 4000,
        frameHeight: 2160,
        framesPerSecond: 29.5,
        qualityLimitationReason: "cpu",
      }),
    ];
    expect(computeTransportStats(entries, "send", 1000).stats).toEqual({
      bitrateKbps: 0,
      frameHeight: 2160,
      framesPerSecond: 29.5,
      qualityLimitationReason: "cpu",
    });
  });

  it("omits missing or invalid outbound video encoding fields and keeps 0 fps", () => {
    const entries = [
      entry("outbound-rtp", "video-no-height", {
        kind: "video",
        bytesSent: 1000,
        framesPerSecond: 0,
        qualityLimitationReason: "unknown-reason",
      }),
    ];
    const stats = computeTransportStats(entries, "send", 1000).stats;
    expect(stats).toEqual({ bitrateKbps: 0, framesPerSecond: 0 });
    expect(stats).not.toHaveProperty("frameHeight");
    expect(stats).not.toHaveProperty("qualityLimitationReason");

    const negative = [
      entry("outbound-rtp", "video-bad", {
        kind: "video",
        frameHeight: -10,
        framesPerSecond: Number.NaN,
      }),
    ];
    const badStats = computeTransportStats(negative, "send", 1000).stats;
    expect(badStats).toEqual({ bitrateKbps: 0 });
  });

  it("prefers a video outbound-rtp entry with frameHeight over one without", () => {
    const entries = [
      entry("outbound-rtp", "video-idle", {
        kind: "video",
        framesPerSecond: 0,
        qualityLimitationReason: "other",
      }),
      entry("outbound-rtp", "video-active", {
        kind: "video",
        frameHeight: 1440,
        framesPerSecond: 30,
        qualityLimitationReason: "bandwidth",
      }),
    ];
    expect(computeTransportStats(entries, "send", 1000).stats).toEqual({
      bitrateKbps: 0,
      frameHeight: 1440,
      framesPerSecond: 30,
      qualityLimitationReason: "bandwidth",
    });
  });

  it("never reports outbound video encoding fields in receive direction", () => {
    const entries = [
      entry("outbound-rtp", "video-out", {
        kind: "video",
        frameHeight: 2160,
        framesPerSecond: 30,
        qualityLimitationReason: "cpu",
      }),
      entry("inbound-rtp", "video-in", {
        kind: "video",
        bytesReceived: 2000,
        frameHeight: 2160,
        framesPerSecond: 30,
      }),
    ];
    const stats = computeTransportStats(entries, "receive", 1000).stats;
    expect(stats).not.toHaveProperty("frameHeight");
    expect(stats).not.toHaveProperty("framesPerSecond");
    expect(stats).not.toHaveProperty("qualityLimitationReason");
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
