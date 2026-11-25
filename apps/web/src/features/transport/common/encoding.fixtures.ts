import type { EncodingTarget } from "@project/shared";

/** 傳輸層測試用的編碼目標（數值任意，只要彼此可區分）。 */
export const TARGETS = {
  smooth: { targetHeight: 720, maxBitrate: 3_000_000, maxFramerate: 30 },
  standard: { targetHeight: 1080, maxBitrate: 6_000_000, maxFramerate: 30 },
  high: { targetHeight: 1080, maxBitrate: 8_000_000, maxFramerate: 30 },
} satisfies Record<string, EncodingTarget>;
