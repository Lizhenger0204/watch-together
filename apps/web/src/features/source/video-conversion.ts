/** streaming.md §1（BUG-004）：已知 8-bit VideoFrame.format 清單，其餘（含 null）一律先轉 8-bit。 */
export const EIGHT_BIT_PIXEL_FORMATS: ReadonlySet<string> = new Set([
  "I420",
  "I420A",
  "I422",
  "I422A",
  "I444",
  "I444A",
  "NV12",
  "RGBA",
  "RGBX",
  "BGRA",
  "BGRX",
]);

export function normalizeFrameFormat(
  format: string | null | undefined,
): string {
  return format == null ? "opaque" : format;
}

export function needsEightBitConversion(
  format: string | null | undefined,
): boolean {
  return !(typeof format === "string" && EIGHT_BIT_PIXEL_FORMATS.has(format));
}

/** 依 streaming.md §1（T-137，ADR 0004 D7）：畫布與原片同尺寸（寬高取偶數），轉換不縮放。 */
export function computeConversionSize(
  videoWidth: number,
  videoHeight: number,
): { width: number; height: number } {
  const width = Math.max(2, Math.floor(videoWidth / 2) * 2);
  const height = Math.max(2, Math.floor(videoHeight / 2) * 2);
  return { width, height };
}

export interface VideoFrameLike {
  readonly format: string | null;
  readonly timestamp: number;
  close(): void;
}

export interface TrackProcessorLike {
  readonly readable: ReadableStream<VideoFrameLike>;
}

export interface TrackGeneratorLike extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrameLike>;
}

export interface Canvas2DContextLike {
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

export interface ConversionCanvasLike {
  readonly source: CanvasImageSource;
  readonly context: Canvas2DContextLike;
}

export interface VideoConversionRuntime {
  readonly TrackProcessor?: new (init: {
    track: MediaStreamTrack;
  }) => TrackProcessorLike;
  readonly TrackGenerator?: new (init: { kind: "video" }) => TrackGeneratorLike;
  readonly createCanvas?: (
    width: number,
    height: number,
  ) => ConversionCanvasLike | null;
  readonly createVideoFrame?: (
    source: CanvasImageSource,
    init: { timestamp: number },
  ) => VideoFrameLike;
  readonly createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

export class ConversionUnsupportedError extends Error {
  constructor(message = "MediaStreamTrackProcessor/Generator unavailable") {
    super(message);
    this.name = "ConversionUnsupportedError";
  }
}

type GlobalWithTrackStreams = typeof globalThis & {
  MediaStreamTrackProcessor?: VideoConversionRuntime["TrackProcessor"];
  MediaStreamTrackGenerator?: VideoConversionRuntime["TrackGenerator"];
};

export function browserConversionRuntime(): VideoConversionRuntime {
  const scope = globalThis as GlobalWithTrackStreams;
  return {
    TrackProcessor: scope.MediaStreamTrackProcessor,
    TrackGenerator: scope.MediaStreamTrackGenerator,
    createCanvas:
      typeof OffscreenCanvas === "function"
        ? (width, height) => {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext("2d");
            return context ? { source: canvas, context } : null;
          }
        : undefined,
    createVideoFrame:
      typeof VideoFrame === "function"
        ? (source, init) => new VideoFrame(source, init)
        : undefined,
    createMediaStream:
      typeof MediaStream === "function"
        ? (tracks) => new MediaStream(tracks)
        : undefined,
  };
}

export type FrameFormatProbeResult =
  | { status: "unsupported" }
  | { status: "empty" }
  | { status: "ok"; frameFormat: string };

/** 從擷取 video track 的 clone 讀第一張 VideoFrame 判斷像素格式，讀完即關閉並停止 clone。 */
export async function probeVideoFrameFormat(
  track: MediaStreamTrack,
  signal: AbortSignal,
  runtime: VideoConversionRuntime = browserConversionRuntime(),
): Promise<FrameFormatProbeResult> {
  signal.throwIfAborted();
  if (!runtime.TrackProcessor) return { status: "unsupported" };

  const cloned = track.clone();
  let reader: ReadableStreamDefaultReader<VideoFrameLike> | undefined;
  const onAbort = () => {
    cloned.stop();
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const processor = new runtime.TrackProcessor({ track: cloned });
    reader = processor.readable.getReader();
    const { value: frame, done } = await reader.read();
    if (signal.aborted) {
      frame?.close();
      signal.throwIfAborted();
    }
    if (done || !frame) return { status: "empty" };
    const frameFormat = normalizeFrameFormat(frame.format);
    frame.close();
    return { status: "ok", frameFormat };
  } finally {
    signal.removeEventListener("abort", onAbort);
    cloned.stop();
    if (reader) {
      await reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // reader 已在 cancel 期間釋放時忽略。
      }
    }
  }
}

export interface EightBitVideoConverter {
  readonly stream: MediaStream;
  readonly waitForFirstFrame: (signal: AbortSignal) => Promise<void>;
  readonly dispose: () => void;
}

/**
 * 將擷取到的非 8-bit video track 經 OffscreenCanvas 轉為 8-bit VideoFrame 寫入單一 generator，
 * 並同步擷取 stream 的音軌增刪（streaming.md §1 BUG-004）。
 */
export function createEightBitVideoConverter(options: {
  captured: MediaStream;
  initialVideoTrack: MediaStreamTrack;
  width: number;
  height: number;
  onTracksChange: () => void;
  runtime?: VideoConversionRuntime;
}): EightBitVideoConverter {
  const { captured, initialVideoTrack, width, height, onTracksChange } =
    options;
  const runtime = options.runtime ?? browserConversionRuntime();
  const {
    TrackProcessor,
    TrackGenerator,
    createCanvas,
    createVideoFrame,
    createMediaStream,
  } = runtime;

  if (
    !TrackProcessor ||
    !TrackGenerator ||
    !createCanvas ||
    !createVideoFrame
  ) {
    throw new ConversionUnsupportedError();
  }
  if (!createMediaStream) {
    throw new ConversionUnsupportedError("MediaStream unavailable");
  }

  const surface = createCanvas(width, height);
  if (!surface) {
    throw new Error("OffscreenCanvas 2D context unavailable");
  }

  const generator = new TrackGenerator({ kind: "video" });
  const output = createMediaStream([generator]);
  for (const audioTrack of captured.getAudioTracks()) {
    if (audioTrack.readyState !== "ended") {
      output.addTrack(audioTrack);
    }
  }

  // 先建立首幀觀察 clone，再接上第一條 pipe，避免漏接第一張輸出的 VideoFrame。
  const firstFrameAbort = new AbortController();
  const firstFramePromise = (async () => {
    const probeTrack = generator.clone();
    let reader: ReadableStreamDefaultReader<VideoFrameLike> | undefined;
    const onAbort = () => {
      probeTrack.stop();
      void reader?.cancel().catch(() => {});
    };
    firstFrameAbort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const processor = new TrackProcessor({ track: probeTrack });
      reader = processor.readable.getReader();
      const { value: frame, done } = await reader.read();
      if (firstFrameAbort.signal.aborted) {
        frame?.close();
        throw firstFrameAbort.signal.reason;
      }
      if (done || !frame) {
        throw new Error("Generator ended before outputting first frame");
      }
      frame.close();
    } finally {
      firstFrameAbort.signal.removeEventListener("abort", onAbort);
      probeTrack.stop();
      if (reader) {
        await reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          // reader 已釋放時忽略。
        }
      }
    }
  })();
  // 防止在 waitForFirstFrame 呼叫前就發生中止／結束而觸發 unhandled rejection。
  void firstFramePromise.catch(() => {});

  let disposed = false;
  let desiredTrack: MediaStreamTrack | null = null;
  let activePipe: {
    track: MediaStreamTrack;
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
  let syncing = false;

  function startPipe(track: MediaStreamTrack) {
    const controller = new AbortController();
    const processor = new TrackProcessor!({ track });
    const transform = new TransformStream<VideoFrameLike, VideoFrameLike>({
      transform(frame, queue) {
        const timestamp = frame.timestamp;
        try {
          if (disposed || controller.signal.aborted) return;
          surface!.context.drawImage(
            frame as unknown as CanvasImageSource,
            0,
            0,
            width,
            height,
          );
        } finally {
          frame.close();
        }
        if (disposed || controller.signal.aborted) return;
        const converted = createVideoFrame!(surface!.source, { timestamp });
        try {
          queue.enqueue(converted);
        } catch {
          converted.close();
        }
      },
    });
    const pipe = {
      track,
      controller,
      done: Promise.resolve(),
    };
    pipe.done = processor.readable
      .pipeThrough(transform)
      .pipeTo(generator.writable, {
        preventClose: true,
        preventAbort: true,
        signal: controller.signal,
      })
      .catch(() => {
        // 播完、換軌或卸載造成的 abort／中斷由生命週期接管，不向外拋出未處理拒絕。
      })
      .finally(() => {
        if (activePipe === pipe) activePipe = null;
      });
    activePipe = pipe;
  }

  async function syncPipe() {
    if (syncing) return;
    syncing = true;
    try {
      while (!disposed) {
        const target = desiredTrack;
        if (activePipe && activePipe.track !== target) {
          if (target !== null) activePipe.controller.abort();
          await activePipe.done;
          continue;
        }
        if (!target || target.readyState === "ended") break;
        if (activePipe?.track === target) break;
        startPipe(target);
        break;
      }
    } finally {
      syncing = false;
    }
    if (
      !disposed &&
      desiredTrack &&
      desiredTrack.readyState !== "ended" &&
      activePipe?.track !== desiredTrack
    ) {
      void syncPipe();
    }
  }

  function connectVideoTrack(track: MediaStreamTrack | null) {
    if (disposed) return;
    desiredTrack = track;
    if (track && activePipe && activePipe.track !== track) {
      activePipe.controller.abort();
    }
    void syncPipe();
  }

  const onAddTrack = (event: MediaStreamTrackEvent) => {
    if (disposed) return;
    if (event.track.kind === "video") {
      connectVideoTrack(event.track);
      return;
    }
    if (event.track.kind === "audio") {
      if (!output.getAudioTracks().includes(event.track)) {
        output.addTrack(event.track);
      }
      onTracksChange();
    }
  };

  const onRemoveTrack = (event: MediaStreamTrackEvent) => {
    if (disposed) return;
    if (event.track.kind === "video") {
      if (desiredTrack === event.track) {
        connectVideoTrack(null);
      }
      return;
    }
    if (event.track.kind === "audio") {
      output.removeTrack(event.track);
      onTracksChange();
    }
  };

  captured.addEventListener("addtrack", onAddTrack);
  captured.addEventListener("removetrack", onRemoveTrack);
  connectVideoTrack(initialVideoTrack);

  async function waitForFirstFrame(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const onSignalAbort = () => firstFrameAbort.abort(signal.reason);
    signal.addEventListener("abort", onSignalAbort, { once: true });
    try {
      await firstFramePromise;
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", onSignalAbort);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    desiredTrack = null;
    firstFrameAbort.abort(new DOMException("Disposed", "AbortError"));
    captured.removeEventListener("addtrack", onAddTrack);
    captured.removeEventListener("removetrack", onRemoveTrack);
    activePipe?.controller.abort();
    generator.stop();
  }

  return {
    stream: output,
    waitForFirstFrame,
    dispose,
  };
}
