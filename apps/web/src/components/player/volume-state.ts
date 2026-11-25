/** 播放器音量狀態（純函式，供 `usePlayerVolume` 與單元測試共用）。 */
export type VolumeState = {
  /** 滑桿位置（0～1），靜音不會改掉它。 */
  volume: number;
  muted: boolean;
  /** 最後一次非零的音量；拖到 0 再取消靜音時回到這個值。 */
  lastAudible: number;
};

export const INITIAL_VOLUME: VolumeState = {
  volume: 1,
  muted: false,
  lastAudible: 1,
};

/** 實際聽到的音量（靜音時為 0）。 */
export function audibleVolume(state: VolumeState): number {
  return state.muted ? 0 : state.volume;
}

/** 拖曳滑桿：夾在 0～1，非零值記為「最後的非零音量」，並解除靜音。 */
export function setVolume(state: VolumeState, next: number): VolumeState {
  const volume = Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 1;
  return {
    volume,
    muted: false,
    lastAudible: volume > 0 ? volume : state.lastAudible,
  };
}

/**
 * 喇叭鍵：正在出聲就靜音；靜音中或音量為 0 就恢復到最後的非零音量
 * （例如 35% → 拖到 0 → 取消靜音 = 35%，不是 100%）。
 */
export function toggleMute(state: VolumeState): VolumeState {
  if (audibleVolume(state) > 0) return { ...state, muted: true };
  return {
    volume: state.volume > 0 ? state.volume : state.lastAudible,
    muted: false,
    lastAudible: state.lastAudible,
  };
}
