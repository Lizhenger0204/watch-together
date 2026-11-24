import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watchPlaybackProgress } from "./playback-progress";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function watching(hasAudio = true, hasVideo = true) {
  const media = { frames: hasVideo ? 10 : 0, dropped: 0, bitrate: 100 };
  const video = Object.assign(new EventTarget(), {
    paused: false,
    currentTime: 1,
    readyState: 4,
    videoWidth: hasVideo ? 640 : 0,
    ownerDocument: { hidden: false },
    getVideoPlaybackQuality: () => ({
      totalVideoFrames: media.frames,
      droppedVideoFrames: media.dropped,
    }),
  });
  const stream = {
    getVideoTracks: () => (hasVideo ? [{ readyState: "live" }] : []),
    getAudioTracks: () => (hasAudio ? [{ readyState: "live" }] : []),
  };
  const audio = {
    srcObject: null as MediaStream | null,
    paused: false,
    currentTime: 0,
  };
  const startAudio = vi.fn(() => {
    audio.srcObject = stream as unknown as MediaStream;
  });
  const report = vi.fn();
  const stop = watchPlaybackProgress(
    video as unknown as HTMLVideoElement,
    stream as unknown as MediaStream,
    () => media.bitrate,
    report,
    { element: audio as unknown as HTMLAudioElement, start: startAudio },
  );
  function tick() {
    video.currentTime += 0.5;
    vi.advanceTimersByTime(500);
  }
  return { video, audio, startAudio, media, report, stop, tick };
}

test("無 waiting 事件、currentTime 仍走但影格停住且零接收：三秒內回報緩衝，出現新影格就恢復", () => {
  const s = watching();
  s.media.bitrate = 0;
  for (let i = 0; i < 4; i++) s.tick();
  expect(s.report).not.toHaveBeenCalledWith(true);
  for (let i = 0; i < 2; i++) s.tick();
  expect(s.report).toHaveBeenLastCalledWith(true);
  s.media.frames++;
  s.tick();
  expect(s.report).toHaveBeenLastCalledWith(false);
});

test("影格都被丟棄時，即使音訊繼續接收也不能當作畫面恢復", () => {
  const s = watching();
  for (let i = 0; i < 6; i++) {
    s.media.frames++;
    s.media.dropped++;
    s.tick();
  }
  expect(s.report).toHaveBeenLastCalledWith(true);
});

test("只有音訊時使用播放時間及接收量，零接收時時鐘空轉也會回報緩衝", () => {
  const s = watching(true, false);
  for (let i = 0; i < 8; i++) s.tick();
  expect(s.report).not.toHaveBeenCalledWith(true);
  s.media.bitrate = 0;
  for (let i = 0; i < 6; i++) s.tick();
  expect(s.report).toHaveBeenLastCalledWith(true);
  s.media.bitrate = 96;
  s.tick();
  expect(s.report).toHaveBeenLastCalledWith(false);
});

test("Chrome 因空影像軌而等不到 metadata 時，只在收到音訊後啟用純音訊播放，依實際播放時間解除緩衝", () => {
  const s = watching();
  s.video.readyState = 0;
  s.video.videoWidth = 0;
  s.media.bitrate = 0;
  vi.advanceTimersByTime(3000);
  expect(s.startAudio).not.toHaveBeenCalled();
  s.media.bitrate = 96;
  vi.advanceTimersByTime(500);
  expect(s.startAudio).toHaveBeenCalledTimes(1);
  expect(s.report).toHaveBeenLastCalledWith(true);
  s.audio.currentTime = 0.5;
  vi.advanceTimersByTime(500);
  expect(s.report).toHaveBeenLastCalledWith(false);
  s.video.dispatchEvent(new Event("waiting"));
  expect(s.report).toHaveBeenLastCalledWith(false);
});

test("分頁隱藏時沒有呈現新影格，仍有接收且播放時間前進則保持播放", () => {
  const s = watching();
  s.video.ownerDocument.hidden = true;
  for (let i = 0; i < 8; i++) s.tick();
  expect(s.report).not.toHaveBeenCalledWith(true);
});

test("卸載或換流時取消舊取樣與事件，下一條 stream 有自己的停格期限", () => {
  const old = watching();
  old.video.dispatchEvent(new Event("waiting"));
  expect(old.report).toHaveBeenLastCalledWith(true);
  old.stop();
  expect(vi.getTimerCount()).toBe(0);
  old.report.mockClear();
  const next = watching();
  old.video.dispatchEvent(new Event("stalled"));
  vi.advanceTimersByTime(2000);
  expect(old.report).not.toHaveBeenCalled();
  expect(next.report).not.toHaveBeenCalledWith(true);
});
