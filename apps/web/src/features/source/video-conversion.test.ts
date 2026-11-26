import { describe, expect, it, vi } from "vitest";
import {
  computeConversionSize,
  ConversionUnsupportedError,
  createEightBitVideoConverter,
  EIGHT_BIT_PIXEL_FORMATS,
  needsEightBitConversion,
  normalizeFrameFormat,
  probeVideoFrameFormat,
  type TrackProcessorLike,
  type VideoConversionRuntime,
  type VideoFrameLike,
} from "./video-conversion";

class FakeVideoFrame implements VideoFrameLike {
  closed = false;
  constructor(
    readonly format: string | null,
    readonly timestamp: number,
  ) {}
  close() {
    this.closed = true;
  }
}

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  stopped = false;
  clones: FakeTrack[] = [];
  private readonly onStopCallbacks: (() => void)[] = [];

  constructor(
    readonly id: string,
    readonly kind: "video" | "audio",
    private readonly onClone?: (clone: FakeTrack) => void,
  ) {
    super();
  }

  onStop(callback: () => void) {
    this.onStopCallbacks.push(callback);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.readyState = "ended";
    for (const callback of this.onStopCallbacks) callback();
  }

  clone() {
    const cloned = new FakeTrack(
      `${this.id}-clone-${this.clones.length + 1}`,
      this.kind,
      this.onClone,
    );
    this.clones.push(cloned);
    this.onClone?.(cloned);
    return cloned as unknown as MediaStreamTrack;
  }
}

class FakeMediaStream extends EventTarget {
  private readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    super();
    this.tracks = [...tracks];
  }

  addTrack(track: MediaStreamTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }

  removeTrack(track: MediaStreamTrack) {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
  }

  getTracks() {
    return [...this.tracks];
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  emitAddTrack(track: MediaStreamTrack) {
    this.addTrack(track);
    this.dispatchEvent(Object.assign(new Event("addtrack"), { track }));
  }

  emitRemoveTrack(track: MediaStreamTrack) {
    this.removeTrack(track);
    this.dispatchEvent(Object.assign(new Event("removetrack"), { track }));
  }
}

describe("video conversion pure helpers", () => {
  it.each([...EIGHT_BIT_PIXEL_FORMATS])(
    "treats known 8-bit format %s as direct pass-through",
    (format) => {
      expect(needsEightBitConversion(format)).toBe(false);
    },
  );

  it.each([null, undefined, "opaque", "I420P10", "P010", "I420P12", "UNKNOWN"])(
    "requires 8-bit conversion for format %s",
    (format) => {
      expect(needsEightBitConversion(format)).toBe(true);
    },
  );

  it("normalizes null frame format to opaque and preserves named formats", () => {
    expect(normalizeFrameFormat(null)).toBe("opaque");
    expect(normalizeFrameFormat(undefined)).toBe("opaque");
    expect(normalizeFrameFormat("NV12")).toBe("NV12");
    expect(normalizeFrameFormat("I420P10")).toBe("I420P10");
  });

  it("computes even canvas dimensions matching the source without downscaling", () => {
    expect(computeConversionSize(3840, 2160)).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(computeConversionSize(2560, 1440)).toEqual({
      width: 2560,
      height: 1440,
    });
    expect(computeConversionSize(1920, 1080)).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(computeConversionSize(1280, 720)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(computeConversionSize(160, 90)).toEqual({ width: 160, height: 90 });
    expect(computeConversionSize(3840, 1608)).toEqual({
      width: 3840,
      height: 1608,
    });
    expect(computeConversionSize(1080, 1920)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(computeConversionSize(1281, 721)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(computeConversionSize(3841, 2161)).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(computeConversionSize(7680, 4320)).toEqual({
      width: 7680,
      height: 4320,
    });
    expect(computeConversionSize(1, 1)).toEqual({ width: 2, height: 2 });
  });
});

describe("probeVideoFrameFormat", () => {
  it("reads the first frame from a clone, closes it, and stops only the clone", async () => {
    const original = new FakeTrack("v1", "video");
    const firstFrame = new FakeVideoFrame(null, 100);
    const runtime: VideoConversionRuntime = {
      TrackProcessor: class implements TrackProcessorLike {
        readonly readable: ReadableStream<VideoFrameLike>;
        constructor() {
          this.readable = new ReadableStream({
            start(controller) {
              controller.enqueue(firstFrame);
            },
          });
        }
      },
    };

    const result = await probeVideoFrameFormat(
      original as unknown as MediaStreamTrack,
      new AbortController().signal,
      runtime,
    );

    expect(result).toEqual({ status: "ok", frameFormat: "opaque" });
    expect(firstFrame.closed).toBe(true);
    expect(original.readyState).toBe("live");
    expect(original.clones).toHaveLength(1);
    expect(original.clones[0]?.stopped).toBe(true);
  });

  it("reports unsupported when MediaStreamTrackProcessor is missing", async () => {
    const original = new FakeTrack("v1", "video");
    const result = await probeVideoFrameFormat(
      original as unknown as MediaStreamTrack,
      new AbortController().signal,
      {},
    );
    expect(result).toEqual({ status: "unsupported" });
    expect(original.clones).toHaveLength(0);
  });

  it("reports empty when the cloned track closes without emitting a frame", async () => {
    const original = new FakeTrack("v1", "video");
    const runtime: VideoConversionRuntime = {
      TrackProcessor: class implements TrackProcessorLike {
        readonly readable = new ReadableStream<VideoFrameLike>({
          start(controller) {
            controller.close();
          },
        });
      },
    };
    const result = await probeVideoFrameFormat(
      original as unknown as MediaStreamTrack,
      new AbortController().signal,
      runtime,
    );
    expect(result).toEqual({ status: "empty" });
    expect(original.clones[0]?.stopped).toBe(true);
  });
});

describe("createEightBitVideoConverter", () => {
  function setupConverterTest() {
    const trackControllers = new Map<
      string,
      ReadableStreamDefaultController<VideoFrameLike>
    >();
    const drawn: Array<{
      frame: VideoFrameLike;
      width: number;
      height: number;
    }> = [];
    const emitted: VideoFrameLike[] = [];
    const outputListeners: Array<(frame: VideoFrameLike) => void> = [];
    let generatorAborted = false;
    let generatorClosed = false;
    let generatorInstance: FakeGenerator | undefined;

    class FakeGenerator extends FakeTrack {
      readonly writable: WritableStream<VideoFrameLike>;
      constructor() {
        super("gen-1", "video");
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        generatorInstance = this;
        this.writable = new WritableStream<VideoFrameLike>({
          write(frame) {
            emitted.push(frame);
            for (const listener of outputListeners) listener(frame);
          },
          close() {
            generatorClosed = true;
          },
          abort() {
            generatorAborted = true;
          },
        });
      }
    }

    class FakeProcessor implements TrackProcessorLike {
      readonly readable: ReadableStream<VideoFrameLike>;
      constructor({ track }: { track: MediaStreamTrack }) {
        const fake = track as unknown as FakeTrack;
        if (fake.id.startsWith("gen-1-clone")) {
          this.readable = new ReadableStream<VideoFrameLike>({
            start(controller) {
              const listener = (frame: VideoFrameLike) => {
                try {
                  controller.enqueue(
                    new FakeVideoFrame("NV12", frame.timestamp),
                  );
                } catch {
                  // 已取消
                }
              };
              outputListeners.push(listener);
              fake.onStop(() => {
                const index = outputListeners.indexOf(listener);
                if (index >= 0) outputListeners.splice(index, 1);
                try {
                  controller.close();
                } catch {
                  // 已關閉
                }
              });
            },
          });
          return;
        }
        this.readable = new ReadableStream<VideoFrameLike>({
          start(controller) {
            trackControllers.set(fake.id, controller);
          },
        });
      }
    }

    const runtime: VideoConversionRuntime = {
      TrackProcessor: FakeProcessor,
      TrackGenerator:
        FakeGenerator as unknown as VideoConversionRuntime["TrackGenerator"],
      createCanvas: () => ({
        source: {} as CanvasImageSource,
        context: {
          drawImage(image, _dx, _dy, width, height) {
            drawn.push({
              frame: image as unknown as VideoFrameLike,
              width,
              height,
            });
          },
        },
      }),
      createVideoFrame: (_source, { timestamp }) =>
        new FakeVideoFrame("NV12", timestamp),
      createMediaStream: (tracks) =>
        new FakeMediaStream(tracks) as unknown as MediaStream,
    };

    return {
      runtime,
      trackControllers,
      drawn,
      emitted,
      getGenerator: () => generatorInstance!,
      wasGeneratorClosed: () => generatorClosed,
      wasGeneratorAborted: () => generatorAborted,
    };
  }

  it("throws ConversionUnsupportedError when MediaStreamTrackGenerator alone is missing", () => {
    const env = setupConverterTest();
    const captured = new FakeMediaStream();
    const videoTrack = new FakeTrack("v1", "video");
    expect(() =>
      createEightBitVideoConverter({
        captured: captured as unknown as MediaStream,
        initialVideoTrack: videoTrack as unknown as MediaStreamTrack,
        width: 160,
        height: 90,
        onTracksChange: () => {},
        runtime: {
          ...env.runtime,
          TrackGenerator: undefined,
        },
      }),
    ).toThrow(ConversionUnsupportedError);
  });

  it("waits for first generator frame, reconnects on replay without overlapping pipes, and syncs audio", async () => {
    const env = setupConverterTest();
    const video1 = new FakeTrack("v1", "video");
    const audio1 = new FakeTrack("a1", "audio");
    const captured = new FakeMediaStream([
      video1 as unknown as MediaStreamTrack,
      audio1 as unknown as MediaStreamTrack,
    ]);
    const onTracksChange = vi.fn();

    const converter = createEightBitVideoConverter({
      captured: captured as unknown as MediaStream,
      initialVideoTrack: video1 as unknown as MediaStreamTrack,
      width: 1920,
      height: 1080,
      onTracksChange,
      runtime: env.runtime,
    });

    const firstFrameReady = vi.fn();
    const waitPromise = converter
      .waitForFirstFrame(new AbortController().signal)
      .then(firstFrameReady);

    // 寫入首幀前不應 resolve。
    await Promise.resolve();
    expect(firstFrameReady).not.toHaveBeenCalled();

    const frame1 = new FakeVideoFrame(null, 1000);
    env.trackControllers.get("v1")!.enqueue(frame1);
    await waitPromise;

    expect(firstFrameReady).toHaveBeenCalledTimes(1);
    expect(frame1.closed).toBe(true);
    expect(env.drawn).toHaveLength(1);
    expect(env.drawn[0]).toMatchObject({ width: 1920, height: 1080 });
    expect(env.emitted[0]?.timestamp).toBe(1000);

    const outputVideoTrack = converter.stream.getVideoTracks()[0];
    expect(outputVideoTrack).toBe(env.getGenerator());
    expect(converter.stream.getAudioTracks()).toEqual([audio1]);

    // 模擬播完但舊 pipe 尚未關閉時，新軌已加入：應先 abort 舊 pipe（preventAbort: true），等解鎖再接新軌。
    const video2 = new FakeTrack("v2", "video");
    captured.emitAddTrack(video2 as unknown as MediaStreamTrack);

    // 等待非同步重接完成。
    await vi.waitFor(() => {
      expect(env.trackControllers.has("v2")).toBe(true);
    });

    const frame2 = new FakeVideoFrame(null, 2000);
    env.trackControllers.get("v2")!.enqueue(frame2);

    await vi.waitFor(() => {
      expect(env.emitted).toHaveLength(2);
    });
    expect(env.emitted[1]?.timestamp).toBe(2000);
    expect(frame2.closed).toBe(true);
    // 送出的 video track 物件維持同一個 generator，且未被關閉或中止。
    expect(converter.stream.getVideoTracks()[0]).toBe(outputVideoTrack);
    expect(env.wasGeneratorClosed()).toBe(false);
    expect(env.wasGeneratorAborted()).toBe(false);

    // 同步音軌移除與新增時，主動呼叫 onTracksChange。
    captured.emitRemoveTrack(audio1 as unknown as MediaStreamTrack);
    expect(converter.stream.getAudioTracks()).toEqual([]);
    expect(onTracksChange).toHaveBeenCalledTimes(1);

    const audio2 = new FakeTrack("a2", "audio");
    captured.emitAddTrack(audio2 as unknown as MediaStreamTrack);
    expect(converter.stream.getAudioTracks()).toEqual([audio2]);
    expect(onTracksChange).toHaveBeenCalledTimes(2);

    // 卸載時停止 generator。
    converter.dispose();
    expect(env.getGenerator().stopped).toBe(true);
  });
});
