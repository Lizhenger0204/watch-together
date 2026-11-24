const SAMPLE_MS = 500;
const STALL_MS = 2500;

/** 只在已點擊觀看且傳輸連通時監看這一個 stream。 */
export function watchPlaybackProgress(
  video: HTMLVideoElement,
  stream: MediaStream,
  getReceiveBitrate: () => number | undefined,
  setBuffering: (buffering: boolean) => void,
  audioFallback: { element: HTMLAudioElement; start: () => void },
) {
  function presentedFrames() {
    const quality = video.getVideoPlaybackQuality?.();
    if (quality) return quality.totalVideoFrames - quality.droppedVideoFrames;
  }

  let lastFrames = presentedFrames();
  let previousElement: HTMLMediaElement = video;
  let lastTime = video.currentTime;
  let lastProgress = performance.now();
  let buffering = false;

  function report(stalled: boolean) {
    if (buffering === stalled) return;
    buffering = stalled;
    setBuffering(stalled);
  }

  function sample() {
    const now = performance.now();
    const frames = presentedFrames();
    const playingElement = audioFallback.element.srcObject
      ? audioFallback.element
      : video;
    if (playingElement !== previousElement) lastTime = 0;
    previousElement = playingElement;
    const time = playingElement.currentTime;
    const bitrate = getReceiveBitrate();
    const hasAudio = stream
      .getAudioTracks()
      .some((track) => track.readyState === "live");
    // P2P 可能有尚未送出影像的 video transceiver；純音訊來源要靠播放時間與接收量。
    const hasVideo =
      stream.getVideoTracks().some((track) => track.readyState === "live") &&
      (video.videoWidth > 0 || !hasAudio);
    // 隱藏分頁可能停止呈現影格；零碼率時，播放時鐘也可能靠補音繼續走。
    const canSeeFrames =
      hasVideo && !video.ownerDocument.hidden && frames !== undefined;
    const advanced = canSeeFrames
      ? frames !== lastFrames
      : time > lastTime && bitrate !== 0;
    lastFrames = frames;
    lastTime = time;
    if (playingElement.paused || advanced) lastProgress = now;
    if (advanced) report(false);
    else if (now - lastProgress >= STALL_MS) {
      report(true);
      if (
        playingElement === video &&
        hasAudio &&
        video.readyState === 0 &&
        (bitrate ?? 0) > 0
      )
        audioFallback.start();
    }
  }

  const waiting = () => {
    if (!audioFallback.element.srcObject) report(true);
  };
  video.addEventListener("waiting", waiting);
  video.addEventListener("stalled", waiting);
  const timer = setInterval(sample, SAMPLE_MS);
  return () => {
    clearInterval(timer);
    video.removeEventListener("waiting", waiting);
    video.removeEventListener("stalled", waiting);
    report(false);
  };
}
