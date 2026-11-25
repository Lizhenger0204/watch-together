import { useState } from "react";
import {
  INITIAL_VOLUME,
  audibleVolume,
  setVolume,
  toggleMute,
} from "./volume-state";

/**
 * 播放器音量狀態（房主與收看端共用）。靜音不會改掉原本的音量，
 * 取消靜音時回到原音量；音量拖到 0 再取消靜音則回到最後的非零音量（見 volume-state.ts）。
 * 實際套用到 <video>／<audio> 由各播放器決定（見 streaming.md §1 房主音量）。
 */
export function usePlayerVolume() {
  const [state, setState] = useState(INITIAL_VOLUME);
  return {
    volume: state.volume,
    muted: state.muted,
    /** 實際聽到的音量（靜音時為 0）。 */
    audible: audibleVolume(state),
    setVolume(next: number) {
      setState((current) => setVolume(current, next));
    },
    toggleMute() {
      setState(toggleMute);
    },
  };
}

export type PlayerVolume = ReturnType<typeof usePlayerVolume>;
