import { QUALITY_PRESETS } from "@project/shared";
import { describe, expect, it } from "vitest";
import {
  applyAudioEncoding,
  applyCodecPreferences,
  applyVideoEncoding,
  preferredAudioCodecs,
  preferredVideoCodecs,
  setVideoContentHint,
} from "./encoding";
import { FakeRtcRtpSender, FakeRtcRtpTransceiver } from "./rtc-fake";

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

  it("drops non-video codecs", () => {
    const opus = { mimeType: "audio/opus", clockRate: 48000 };
    const h264 = { mimeType: "video/H264", clockRate: 90000 };
    expect(preferredVideoCodecs([opus, h264])).toEqual([h264]);
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
    await applyVideoEncoding(sender, QUALITY_PRESETS.standard, 2160);
    expect(sender.lastParameters?.encodings[0]).toMatchObject({
      maxBitrate: 6_000_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 2,
    });
    expect(sender.lastParameters?.degradationPreference).toBe(
      "maintain-framerate",
    );
  });

  it("scales 4K down to 720p by 3 for the smooth preset", async () => {
    const sender = new FakeRtcRtpSender(null);
    await applyVideoEncoding(sender, QUALITY_PRESETS.smooth, 2160);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(3);
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
