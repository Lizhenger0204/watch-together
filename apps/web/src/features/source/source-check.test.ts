import { describe, expect, it, vi } from "vitest";
import { loadMetadata } from "./browser-source";
import { classifyCapturedTracks, computeScaleDownBy } from "./source-check";

describe("computeScaleDownBy", () => {
  it("keeps the source resolution when it fits", () => {
    expect(computeScaleDownBy(720, 1080)).toBe(1);
    expect(computeScaleDownBy(1080, 1080)).toBe(1);
  });

  it("scales 4K to the target height", () => {
    expect(computeScaleDownBy(2160, 720)).toBe(3);
    expect(computeScaleDownBy(2160, 1080)).toBe(2);
    expect(computeScaleDownBy(1080, 720)).toBe(1.5);
  });
});

describe("source checks", () => {
  it.each([
    [1, 1, "OK"],
    [1, 0, "NO_AUDIO"],
    [0, 1, "CAPTURE_FAILED"],
    [2, 1, "CAPTURE_FAILED"],
  ])("classifies %d video and %d audio tracks as %s", (video, audio, code) => {
    expect(classifyCapturedTracks(video, audio)).toBe(code);
  });

  it("classifies a browser media error as an undecodable video", async () => {
    const video = new EventTarget();
    const check = loadMetadata(
      video as HTMLVideoElement,
      "blob:test",
      new AbortController().signal,
    );
    video.dispatchEvent(new Event("error"));
    await expect(check).rejects.toMatchObject({ code: "VIDEO_UNDECODABLE" });
  });

  it("times out if metadata is unavailable after 10 seconds", async () => {
    vi.useFakeTimers();

    try {
      const video = new EventTarget();
      const check = loadMetadata(
        video as HTMLVideoElement,
        "blob:test",
        new AbortController().signal,
      );
      const failure = expect(check).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });
});
