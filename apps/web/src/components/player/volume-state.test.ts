import { describe, expect, it } from "vitest";
import {
  INITIAL_VOLUME,
  audibleVolume,
  setVolume,
  toggleMute,
} from "./volume-state";

describe("播放器音量狀態", () => {
  it("初始為最大音量、未靜音", () => {
    expect(audibleVolume(INITIAL_VOLUME)).toBe(1);
  });

  it("靜音不改原音量，取消靜音回到原音量", () => {
    const muted = toggleMute(setVolume(INITIAL_VOLUME, 0.35));
    expect(muted.muted).toBe(true);
    expect(audibleVolume(muted)).toBe(0);
    const back = toggleMute(muted);
    expect(audibleVolume(back)).toBe(0.35);
  });

  it("調到 35% 再拉到 0，取消靜音要回到最後的非零音量 35%（不是 100%）", () => {
    const atZero = setVolume(setVolume(INITIAL_VOLUME, 0.35), 0);
    expect(audibleVolume(atZero)).toBe(0);
    const restored = toggleMute(atZero);
    expect(restored.muted).toBe(false);
    expect(audibleVolume(restored)).toBe(0.35);
  });

  it("連續拉到 0 再取消、再拉到 0 再取消，仍是最後的非零音量", () => {
    let state = setVolume(INITIAL_VOLUME, 0.6);
    state = setVolume(state, 0.2);
    state = setVolume(state, 0);
    state = toggleMute(state);
    expect(audibleVolume(state)).toBe(0.2);
    state = setVolume(state, 0);
    state = toggleMute(state);
    expect(audibleVolume(state)).toBe(0.2);
  });

  it("拖滑桿會解除靜音並記住新的音量", () => {
    const muted = toggleMute(INITIAL_VOLUME);
    const moved = setVolume(muted, 0.5);
    expect(moved.muted).toBe(false);
    expect(audibleVolume(moved)).toBe(0.5);
  });

  it("音量夾在 0～1，非數字視為最大音量", () => {
    expect(setVolume(INITIAL_VOLUME, 3).volume).toBe(1);
    expect(setVolume(INITIAL_VOLUME, -1).volume).toBe(0);
    expect(setVolume(INITIAL_VOLUME, Number.NaN).volume).toBe(1);
  });
});
