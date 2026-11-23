import type { Quality } from "./schemas/common";

export type QualityPreset = {
  label: string;
  targetHeight: number;
  maxBitrate: number; // bps
  maxFramerate: number;
};

/** 見 docs/specs/streaming.md §2。 */
export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  smooth: {
    label: "流暢",
    targetHeight: 720,
    maxBitrate: 3_000_000,
    maxFramerate: 30,
  },
  standard: {
    label: "標準",
    targetHeight: 1080,
    maxBitrate: 6_000_000,
    maxFramerate: 30,
  },
  high: {
    label: "高畫質",
    targetHeight: 1080,
    maxBitrate: 8_000_000,
    maxFramerate: 30,
  },
};

export const DEFAULT_QUALITY: Quality = "standard";

export const AUDIO_MAX_BITRATE = 128_000;

/** P2P 預估總上傳量超過此值時提示房主（streaming.md §2）。 */
export const P2P_TOTAL_BITRATE_WARNING = 60_000_000;
