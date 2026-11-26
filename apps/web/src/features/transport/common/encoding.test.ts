import { resolveQuality } from "@project/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAudioEncoding,
  applyCodecPreferences,
  applyVideoEncoding,
  browserReceiverCodecCapabilities,
  preferredAudioCodecs,
  preferredVideoCodecs,
  setVideoContentHint,
} from "./encoding";
import { FakeRtcRtpSender, FakeRtcRtpTransceiver } from "./rtc-fake";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preferredVideoCodecs", () => {
  it("puts H.264 first, then VP8, then the rest (stable order)", () => {
    const vp9 = { mimeType: "video/VP9", clockRate: 90000 };
    const vp8 = { mimeType: "video/VP8", clockRate: 90000 };
    const h264 = { mimeType: "video/H264", clockRate: 90000 };
    const av1 = { mimeType: "video/AV1", clockRate: 90000 };
    expect(preferredVideoCodecs([vp9, vp8, h264, av1])).toEqual([
      h264,
      vp8,
      vp9,
      av1,
    ]);
  });

  it("orders H.264 profiles deterministically: 4200xx pm=1 → 42e0xx pm=1 → other pm=1/plain → pm=0 → VP8 → rest", () => {
    const vp8 = { mimeType: "video/VP8", clockRate: 90000 };
    const rtx = { mimeType: "video/rtx", clockRate: 90000 };
    const vp9 = { mimeType: "video/VP9", clockRate: 90000 };
    const h264Pm0Base = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine:
        "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f",
    };
    const h264Pm0Cb = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine:
        "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f",
    };
    const h264High = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine:
        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034",
    };
    const h264Main = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine:
        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
    };
    const h264Plain = { mimeType: "video/H264", clockRate: 90000 };
    const h264CbPm1 = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine:
        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    };
    const h264BasePm1 = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine:
        "profile-level-id=42001F; packetization-mode=1; level-asymmetry-allowed=1",
    };

    expect(
      preferredVideoCodecs([
        vp9,
        vp8,
        rtx,
        h264Pm0Base,
        h264High,
        h264CbPm1,
        h264Pm0Cb,
        h264Main,
        h264Plain,
        h264BasePm1,
      ]),
    ).toEqual([
      h264BasePm1,
      h264CbPm1,
      h264High,
      h264Main,
      h264Plain,
      h264Pm0Base,
      h264Pm0Cb,
      vp8,
      vp9,
      rtx,
    ]);
  });

  it("swaps only 4200xx and 42e0xx in Safari mode", () => {
    const vp8 = { mimeType: "video/VP8", clockRate: 90000 };
    const base = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine: "packetization-mode=1;profile-level-id=42001f",
    };
    const constrained = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
    };
    const high = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine: "packetization-mode=1;profile-level-id=64001f",
    };
    const codecs = [vp8, high, base, constrained];
    expect(preferredVideoCodecs(codecs, { safariMode: true })).toEqual([
      constrained,
      base,
      high,
      vp8,
    ]);
    expect(preferredVideoCodecs(codecs, { safariMode: false })).toEqual([
      base,
      constrained,
      high,
      vp8,
    ]);
  });

  it("drops non-video codecs", () => {
    const opus = { mimeType: "audio/opus", clockRate: 48000 };
    const h264 = { mimeType: "video/H264", clockRate: 90000 };
    expect(preferredVideoCodecs([opus, h264])).toEqual([h264]);
  });
});

describe("browserReceiverCodecCapabilities", () => {
  it("reads codecs from RTCRtpReceiver.getCapabilities and falls back safely", () => {
    const expected = [{ mimeType: "video/H264", clockRate: 90000 }];
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: vi.fn(() => ({ codecs: expected })),
    });
    expect(browserReceiverCodecCapabilities("video")).toEqual(expected);

    vi.stubGlobal("RTCRtpReceiver", undefined);
    expect(browserReceiverCodecCapabilities("video")).toEqual([]);
  });
});

describe("preferredAudioCodecs", () => {
  it("keeps only Opus", () => {
    const opus = { mimeType: "audio/opus", clockRate: 48000 };
    const pcmu = { mimeType: "audio/PCMU", clockRate: 8000 };
    const h264 = { mimeType: "video/H264", clockRate: 90000 };
    expect(preferredAudioCodecs([opus, pcmu, h264])).toEqual([opus]);
  });
});

describe("applyVideoEncoding", () => {
  it("sets bitrate, framerate and scale on each encoding", async () => {
    const sender = new FakeRtcRtpSender(null);
    await applyVideoEncoding(
      sender,
      { targetHeight: 1080, maxBitrate: 8_000_000, maxFramerate: 30 },
      2160,
    );
    expect(sender.lastParameters?.encodings[0]).toMatchObject({
      maxBitrate: 8_000_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 2,
    });
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-framerate",
    );
  });

  it("scales 4K down to 720p by 3 and 900p by 2.4", async () => {
    const sender = new FakeRtcRtpSender(null);
    const at = (height: 720 | 900) =>
      resolveQuality({ height, bitrate: 8_000_000, fps: 30 }, null);
    await applyVideoEncoding(sender, at(720), 2160);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(3);
    await applyVideoEncoding(sender, at(900), 2160);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(
      2.4,
    );
  });

  it("never upscales a source shorter than the target height", async () => {
    const sender = new FakeRtcRtpSender(null);
    await applyVideoEncoding(
      sender,
      { targetHeight: 1080, maxBitrate: 8_000_000, maxFramerate: 30 },
      720,
    );
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(1);
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-framerate",
    );
  });

  it("keeps scale 1 for source resolution and switches degradationPreference above 1080", async () => {
    const sender = new FakeRtcRtpSender(null);
    const sourceTarget = resolveQuality(
      { height: "source", bitrate: 25_000_000, fps: 30 },
      null,
    );

    await applyVideoEncoding(sender, sourceTarget, 2160);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(1);
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-resolution",
    );

    await applyVideoEncoding(sender, sourceTarget, 1608);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(1);
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-resolution",
    );

    await applyVideoEncoding(sender, sourceTarget, 1080);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(1);
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-framerate",
    );
  });

  it("uses maintain-resolution for sent heights > 1080 and restores maintain-framerate at ≤ 1080", async () => {
    const sender = new FakeRtcRtpSender(null);

    await applyVideoEncoding(
      sender,
      { targetHeight: 2160, maxBitrate: 25_000_000, maxFramerate: 30 },
      2160,
    );
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(1);
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-resolution",
    );

    await applyVideoEncoding(
      sender,
      { targetHeight: 1440, maxBitrate: 15_000_000, maxFramerate: 30 },
      2160,
    );
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(
      1.5,
    );
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-resolution",
    );

    // 4K 片源切回 1080P：縮放 2 倍、恢復 maintain-framerate
    await applyVideoEncoding(
      sender,
      { targetHeight: 1080, maxBitrate: 8_000_000, maxFramerate: 30 },
      2160,
    );
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(2);
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-framerate",
    );

    // 1080P 片源設定 2160P：實際送出高度是 1080，維持 maintain-framerate
    await applyVideoEncoding(
      sender,
      { targetHeight: 2160, maxBitrate: 25_000_000, maxFramerate: 30 },
      1080,
    );
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(1);
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-framerate",
    );
  });

  it("removes a previous framerate cap when switching to source fps", async () => {
    const sender = new FakeRtcRtpSender(null);
    await applyVideoEncoding(
      sender,
      { targetHeight: 1080, maxBitrate: 8_000_000, maxFramerate: 24 },
      1080,
    );
    await applyVideoEncoding(
      sender,
      { targetHeight: 1080, maxBitrate: 15_000_000, maxFramerate: null },
      1080,
    );
    const encoding = sender.lastParameters?.encodings[0];
    expect(encoding?.maxBitrate).toBe(15_000_000);
    expect(encoding).not.toHaveProperty("maxFramerate");
  });
});

describe("applyAudioEncoding", () => {
  it("caps audio at 128 kbps", async () => {
    const sender = new FakeRtcRtpSender(null);
    await applyAudioEncoding(sender);
    expect(sender.lastParameters?.encodings[0]?.maxBitrate).toBe(128_000);
  });
});

describe("applyCodecPreferences", () => {
  it("orders video codecs H.264 first and sets them", () => {
    const transceiver = new FakeRtcRtpTransceiver("video", null);
    const vp8 = { mimeType: "video/VP8", clockRate: 90000 };
    const h264 = { mimeType: "video/H264", clockRate: 90000 };
    applyCodecPreferences(transceiver, [vp8, h264]);
    expect(transceiver.codecPreferences).toEqual([h264, vp8]);
  });

  it("keeps only Opus for audio", () => {
    const transceiver = new FakeRtcRtpTransceiver("audio", null);
    const opus = { mimeType: "audio/opus", clockRate: 48000 };
    const pcmu = { mimeType: "audio/PCMU", clockRate: 8000 };
    applyCodecPreferences(transceiver, [opus, pcmu]);
    expect(transceiver.codecPreferences).toEqual([opus]);
  });
});

describe("setVideoContentHint", () => {
  it("sets contentHint to motion", () => {
    const track = { contentHint: "" } as MediaStreamTrack;
    setVideoContentHint(track);
    expect(track.contentHint).toBe("motion");
  });
});
