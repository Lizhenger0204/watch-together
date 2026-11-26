import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadMetadata,
  probePlayback,
  retireCapturedStream,
} from "./browser-source";

function media() {
  return Object.assign(new EventTarget(), {
    error: null as { code: number; message: string } | null,
    videoWidth: 160,
    videoHeight: 90,
    currentTime: 0,
    readyState: 4,
    networkState: 1,
    muted: false,
    loop: false,
    play: () => Promise.resolve(),
    pause: () => {},
    getVideoPlaybackQuality: () => ({
      totalVideoFrames: 0,
      droppedVideoFrames: 0,
    }),
  });
}

afterEach(() => vi.useRealTimers());

describe("browser source checks", () => {
  it("keeps the native media error and failed stage before the source is released", async () => {
    const video = media();
    const check = loadMetadata(
      video as unknown as HTMLVideoElement,
      "blob:test",
      new AbortController().signal,
    );
    video.error = { code: 3, message: "DECODER_ERROR_NOT_SUPPORTED" };
    video.dispatchEvent(new Event("error"));
    await expect(check).rejects.toMatchObject({
      code: "VIDEO_UNDECODABLE",
      diagnostic: {
        stage: "metadata",
        mediaError: { code: 3, message: "DECODER_ERROR_NOT_SUPPORTED" },
      },
    });
  });

  it("rejects a stalled trial even when play resolves and one wall-clock second passes", async () => {
    vi.useFakeTimers();
    const video = media();
    const check = probePlayback(
      video as unknown as HTMLVideoElement,
      new AbortController().signal,
    );
    const failure = expect(check).rejects.toMatchObject({
      code: "TIMEOUT",
      diagnostic: { stage: "playback", currentTime: 0 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(video.muted).toBe(false);
    expect(video.loop).toBe(false);
  });

  it("waits for a late live capture track after native decoding has advanced", async () => {
    vi.useFakeTimers();
    const video = media();
    const tracks: { readyState: string }[] = [];
    const stream = Object.assign(new EventTarget(), {
      getVideoTracks: () => tracks,
      getAudioTracks: () => [],
    });
    const check = probePlayback(
      video as unknown as HTMLVideoElement,
      new AbortController().signal,
      stream as unknown as MediaStream,
    );
    const result = check.then(() => "ready");
    video.currentTime = 1.1;
    video.getVideoPlaybackQuality = () => ({
      totalVideoFrames: 12,
      droppedVideoFrames: 0,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    tracks.push({ readyState: "live" });
    stream.dispatchEvent(new Event("addtrack"));
    await expect(result).resolves.toBe("ready");
    expect(video.currentTime).toBe(0);
    expect(video.muted).toBe(false);
  });

  it("distinguishes capture failure from successful native decoding", async () => {
    vi.useFakeTimers();
    const video = media();
    const stream = Object.assign(new EventTarget(), {
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    const check = probePlayback(
      video as unknown as HTMLVideoElement,
      new AbortController().signal,
      stream as unknown as MediaStream,
    );
    const failure = expect(check).rejects.toMatchObject({
      code: "CAPTURE_FAILED",
      diagnostic: { stage: "capture", decodedFrames: 12, videoTracks: 0 },
    });
    video.currentTime = 1.1;
    video.getVideoPlaybackQuality = () => ({
      totalVideoFrames: 12,
      droppedVideoFrames: 0,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
  });

  it("aborts an old trial without resetting the next selected source", async () => {
    vi.useFakeTimers();
    const video = media();
    const controller = new AbortController();
    const check = probePlayback(
      video as unknown as HTMLVideoElement,
      controller.signal,
    );
    const failure = expect(check).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    video.currentTime = 4;
    await vi.runAllTimersAsync();
    await failure;
    expect(video.currentTime).toBe(4);
  });

  it("does not mute a new source when an already retired trial resumes", async () => {
    const video = media();
    const controller = new AbortController();
    controller.abort();
    await expect(
      probePlayback(video as unknown as HTMLVideoElement, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(video.muted).toBe(false);
    expect(video.loop).toBe(false);
  });

  it("waits for converted output first frame before completing trial and records conversion metadata", async () => {
    vi.useFakeTimers();
    const video = media();
    const track = { readyState: "live" } as unknown as MediaStreamTrack;
    const stream = Object.assign(new EventTarget(), {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    }) as unknown as MediaStream;
    const outputStream = Object.assign(new EventTarget(), {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    }) as unknown as MediaStream;

    let resolveFirstFrame!: () => void;
    let settled = false;
    const check = probePlayback(
      video as unknown as HTMLVideoElement,
      new AbortController().signal,
      stream,
      {
        prepareCapture: async (_track, _signal, progress) => {
          progress.setFrameFormat("opaque");
          progress.setConverted(true);
          await new Promise<void>((resolve) => {
            resolveFirstFrame = resolve;
          });
          return {
            stream: outputStream,
            frameFormat: "opaque",
            converted: true,
          };
        },
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    video.currentTime = 1.2;
    video.getVideoPlaybackQuality = () => ({
      totalVideoFrames: 12,
      droppedVideoFrames: 0,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    // 轉換首幀尚未輸出前，不可進入 ready。
    expect(settled).toBe(false);

    resolveFirstFrame();
    await expect(check).resolves.toMatchObject({
      stream: outputStream,
      frameFormat: "opaque",
      converted: true,
    });
  });

  it("fails with CAPTURE_FAILED and preserves frameFormat/converted when generator never outputs a frame", async () => {
    vi.useFakeTimers();
    const video = media();
    const track = { readyState: "live" } as unknown as MediaStreamTrack;
    const stream = Object.assign(new EventTarget(), {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    }) as unknown as MediaStream;

    const check = probePlayback(
      video as unknown as HTMLVideoElement,
      new AbortController().signal,
      stream,
      {
        prepareCapture: async (_track, signal, progress) => {
          progress.setFrameFormat("opaque");
          progress.setConverted(true);
          await new Promise<void>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          return { stream, frameFormat: "opaque", converted: true };
        },
      },
    );
    const failure = expect(check).rejects.toMatchObject({
      code: "CAPTURE_FAILED",
      diagnostic: {
        stage: "capture",
        frameFormat: "opaque",
        converted: true,
      },
    });

    video.currentTime = 1.2;
    video.getVideoPlaybackQuality = () => ({
      totalVideoFrames: 12,
      droppedVideoFrames: 0,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
  });

  it("stops existing and subsequently added tracks on a retired capture stream", () => {
    const makeTrack = () => {
      const track = {
        readyState: "live" as MediaStreamTrackState,
        stopCalls: 0,
        stop() {
          this.stopCalls += 1;
          this.readyState = "ended";
        },
      };
      return track;
    };

    const existingVideo = makeTrack();
    const existingAudio = makeTrack();
    const tracks = [existingVideo, existingAudio];
    const stream = Object.assign(new EventTarget(), {
      getTracks: () => [...tracks],
    }) as unknown as MediaStream;

    retireCapturedStream(stream);
    retireCapturedStream(stream);

    expect(existingVideo.readyState).toBe("ended");
    expect(existingAudio.readyState).toBe("ended");
    expect(existingVideo.stopCalls).toBe(1);
    expect(existingAudio.stopCalls).toBe(1);

    const lateVideo = makeTrack();
    const lateAudio = makeTrack();
    tracks.push(lateVideo, lateAudio);
    stream.dispatchEvent(
      Object.assign(new Event("addtrack"), { track: lateVideo }),
    );
    stream.dispatchEvent(
      Object.assign(new Event("addtrack"), { track: lateAudio }),
    );

    expect(lateVideo.readyState).toBe("ended");
    expect(lateAudio.readyState).toBe("ended");
    expect(lateVideo.stopCalls).toBe(1);
    expect(lateAudio.stopCalls).toBe(1);
  });
});
