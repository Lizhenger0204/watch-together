import {
  SourceCheckError,
  type SourceCheckCode,
  type SourceCheckStage,
} from "./source-check";

const CHECK_TIMEOUT_MS = 10_000;
const PROBE_DURATION_MS = 1_000;

function decodedFrames(video: HTMLVideoElement) {
  const quality = video.getVideoPlaybackQuality?.();
  return quality ? quality.totalVideoFrames - quality.droppedVideoFrames : 0;
}

export interface SourceDiagnosticExtra {
  frameFormat?: string | null;
  converted?: boolean;
}

export interface PreparedCapture {
  stream: MediaStream;
  frameFormat: string | null;
  converted: boolean;
  dispose?: () => void;
}

export interface ProbePlaybackOptions {
  prepareCapture?: (
    track: MediaStreamTrack,
    signal: AbortSignal,
    progress: {
      setFrameFormat: (format: string | null) => void;
      setConverted: (converted: boolean) => void;
    },
  ) => Promise<PreparedCapture>;
}

export function sourceFailure(
  video: HTMLVideoElement,
  code: Exclude<SourceCheckCode, "NO_AUDIO">,
  stage: SourceCheckStage,
  stream?: MediaStream,
  failure?: unknown,
  extra?: SourceDiagnosticExtra,
) {
  return new SourceCheckError(code, {
    stage,
    mediaError: video.error
      ? { code: video.error.code, message: video.error.message }
      : null,
    failure: failure instanceof Error ? failure.name : null,
    width: video.videoWidth,
    height: video.videoHeight,
    readyState: video.readyState,
    currentTime: video.currentTime,
    decodedFrames: decodedFrames(video),
    videoTracks: stream?.getVideoTracks().length ?? null,
    audioTracks: stream?.getAudioTracks().length ?? null,
    frameFormat: extra?.frameFormat ?? null,
    converted: extra?.converted ?? false,
  });
}

function waitForMedia(
  video: HTMLVideoElement,
  signal: AbortSignal,
  start: (done: () => void, fail: (error: unknown) => void) => () => void,
  stage: () => SourceCheckStage,
  stream?: MediaStream,
  diagnosticExtra?: () => SourceDiagnosticExtra,
) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();

    let stop = () => {};
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      stop();
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = () =>
      fail(
        sourceFailure(
          video,
          "VIDEO_UNDECODABLE",
          stage(),
          stream,
          undefined,
          diagnosticExtra?.(),
        ),
      );
    const onAbort = () => fail(signal.reason);
    const timeout = setTimeout(
      () =>
        fail(
          sourceFailure(
            video,
            stage() === "capture" ? "CAPTURE_FAILED" : "TIMEOUT",
            stage(),
            stream,
            undefined,
            diagnosticExtra?.(),
          ),
        ),
      CHECK_TIMEOUT_MS,
    );
    video.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      stop = start(done, fail);
      if (settled) stop();
    } catch (error) {
      fail(error);
    }
  });
}

export function loadMetadata(
  video: HTMLVideoElement,
  url: string,
  signal: AbortSignal,
) {
  return waitForMedia(
    video,
    signal,
    (done) => {
      video.addEventListener("loadedmetadata", done, { once: true });
      video.src = url;
      return () => video.removeEventListener("loadedmetadata", done);
    },
    () => "metadata",
  );
}

export function captureVideo(video: HTMLVideoElement) {
  const { captureStream } = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
  };
  if (!captureStream)
    throw sourceFailure(video, "CAPTURE_UNSUPPORTED", "capture");
  try {
    return captureStream.call(video);
  } catch (error) {
    throw sourceFailure(video, "CAPTURE_FAILED", "capture", undefined, error);
  }
}

const retiredCaptureStreams = new WeakSet<MediaStream>();

function stopRetiredTrack(event: MediaStreamTrackEvent) {
  event.track.stop();
}

/**
 * 停用已退役的擷取 MediaStream：立即停止目前所有 track，並持續監聽 addtrack 立即停止
 * 同一個 <video> 在後續換片或重播時由 Chrome 補進舊 stream 的新 track（BUG-004）。
 */
export function retireCapturedStream(stream: MediaStream) {
  if (retiredCaptureStreams.has(stream)) return;
  retiredCaptureStreams.add(stream);
  stream.addEventListener("addtrack", stopRetiredTrack);
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function probePlayback(
  video: HTMLVideoElement,
  signal: AbortSignal,
  stream?: MediaStream,
  options?: ProbePlaybackOptions,
): Promise<PreparedCapture | undefined> {
  signal.throwIfAborted();
  video.muted = true;
  video.loop = true;
  const initialFrames = decodedFrames(video);
  let previousTime = video.currentTime;
  let playedSeconds = 0;
  let frameFormat: string | null = null;
  let converted = false;
  let prepared: PreparedCapture | undefined;
  const hasProgress = () =>
    decodedFrames(video) - initialFrames >= 2 &&
    playedSeconds >= PROBE_DURATION_MS / 1000;
  const diagnosticExtra = (): SourceDiagnosticExtra => ({
    frameFormat,
    converted,
  });

  try {
    await waitForMedia(
      video,
      signal,
      (done, fail) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancelled = false;
        let elapsed = false;
        let prepareStarted = false;
        let frameCallback: number | undefined;
        const prepareController = new AbortController();
        const check = () => {
          const currentTime = video.currentTime;
          // 短片會在靜音試播期間 loop，累計真正播放過的媒體時間。
          const delta =
            currentTime >= previousTime
              ? currentTime - previousTime
              : Number.isFinite(video.duration)
                ? video.duration - previousTime + currentTime
                : 0;
          playedSeconds += Math.max(0, delta);
          previousTime = currentTime;
          const liveVideoTracks =
            stream
              ?.getVideoTracks()
              .filter((track) => track.readyState === "live") ?? [];
          if (
            options?.prepareCapture &&
            !prepareStarted &&
            liveVideoTracks.length === 1
          ) {
            prepareStarted = true;
            void options
              .prepareCapture(liveVideoTracks[0]!, prepareController.signal, {
                setFrameFormat: (format) => {
                  frameFormat = format;
                },
                setConverted: (value) => {
                  converted = value;
                },
              })
              .then(
                (result) => {
                  if (cancelled) {
                    result.dispose?.();
                    return;
                  }
                  prepared = result;
                  frameFormat = result.frameFormat;
                  converted = result.converted;
                  check();
                },
                (error: unknown) => {
                  if (cancelled || prepareController.signal.aborted) return;
                  if (error instanceof SourceCheckError) {
                    fail(error);
                    return;
                  }
                  fail(
                    sourceFailure(
                      video,
                      "CAPTURE_FAILED",
                      "capture",
                      stream,
                      error,
                      diagnosticExtra(),
                    ),
                  );
                },
              );
          }
          const captureReady =
            !stream ||
            (liveVideoTracks.length === 1 &&
              (!options?.prepareCapture || prepared !== undefined));
          if (elapsed && hasProgress() && captureReady) done();
        };
        const onFrame = () => {
          check();
          if (!cancelled)
            frameCallback = video.requestVideoFrameCallback(onFrame);
        };
        video.addEventListener("timeupdate", check);
        stream?.addEventListener("addtrack", check);
        if (video.requestVideoFrameCallback)
          frameCallback = video.requestVideoFrameCallback(onFrame);
        void video.play().then(
          () => {
            if (!cancelled) {
              check();
              timer = setTimeout(() => {
                elapsed = true;
                check();
              }, PROBE_DURATION_MS);
            }
          },
          (error: unknown) =>
            fail(
              sourceFailure(
                video,
                "PLAYBACK_FAILED",
                "playback",
                stream,
                error,
                diagnosticExtra(),
              ),
            ),
        );
        return () => {
          cancelled = true;
          if (!prepared) prepareController.abort(signal.reason);
          clearTimeout(timer);
          if (frameCallback !== undefined)
            video.cancelVideoFrameCallback(frameCallback);
          video.removeEventListener("timeupdate", check);
          stream?.removeEventListener("addtrack", check);
        };
      },
      () => (hasProgress() ? "capture" : "playback"),
      stream,
      diagnosticExtra,
    );
    video.pause();
    await waitForMedia(
      video,
      signal,
      (done) => {
        video.addEventListener("seeked", done, { once: true });
        video.currentTime = 0;
        if (!video.seeking) done();
        return () => video.removeEventListener("seeked", done);
      },
      () => "rewind",
      prepared?.stream ?? stream,
      diagnosticExtra,
    );
    return prepared;
  } finally {
    if (!signal.aborted) {
      video.pause();
      video.loop = false;
      video.muted = false;
    }
  }
}
