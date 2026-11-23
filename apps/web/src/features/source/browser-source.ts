import { SourceCheckError } from "./source-check";

const CHECK_TIMEOUT_MS = 10_000;
const PROBE_DURATION_MS = 1_000;

function waitForMedia(
  video: HTMLVideoElement,
  signal: AbortSignal,
  start: (done: () => void, fail: (error: unknown) => void) => () => void,
) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();

    let stop = () => {};
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      stop();
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onError = () => fail(new SourceCheckError("VIDEO_UNDECODABLE"));
    const onAbort = () => fail(signal.reason);
    const timeout = setTimeout(
      () => fail(new SourceCheckError("TIMEOUT")),
      CHECK_TIMEOUT_MS,
    );
    video.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    stop = start(done, fail);
  });
}

export function loadMetadata(
  video: HTMLVideoElement,
  url: string,
  signal: AbortSignal,
) {
  return waitForMedia(video, signal, (done) => {
    video.addEventListener("loadedmetadata", done, { once: true });
    video.src = url;
    return () => video.removeEventListener("loadedmetadata", done);
  });
}

export function captureVideo(video: HTMLVideoElement) {
  const { captureStream } = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
  };
  if (!captureStream) throw new SourceCheckError("CAPTURE_UNSUPPORTED");
  return captureStream.call(video);
}

export async function probePlayback(
  video: HTMLVideoElement,
  signal: AbortSignal,
) {
  video.muted = true;
  video.loop = true;

  try {
    await waitForMedia(video, signal, (done, fail) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      void video.play().then(() => {
        if (!cancelled) timer = setTimeout(done, PROBE_DURATION_MS);
      }, fail);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    });
  } finally {
    if (!signal.aborted) {
      video.pause();
      video.currentTime = 0;
      video.loop = false;
      video.muted = false;
    }
  }
}
