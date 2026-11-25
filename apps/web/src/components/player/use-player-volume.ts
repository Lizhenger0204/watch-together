import { useState } from "react";

/**
 * 播放器音量狀態（房主與收看端共用）。靜音不會改掉原本的音量，
 * 取消靜音時回到原音量；音量拖到 0 再按靜音鍵則回到最大音量。
 * 實際套用到 <video>／<audio> 由各播放器決定（見 streaming.md §1 房主音量）。
 */
export function usePlayerVolume() {
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  return {
    volume,
    muted,
    /** 實際聽到的音量（靜音時為 0）。 */
    audible: muted ? 0 : volume,
    setVolume(next: number) {
      setVolumeState(Math.min(1, Math.max(0, next)));
      setMuted(false);
    },
    toggleMute() {
      if (muted) setMuted(false);
      else if (volume === 0) setVolumeState(1);
      else setMuted(true);
    },
  };
}

export type PlayerVolume = ReturnType<typeof usePlayerVolume>;
