import { qualitySchema, type Quality } from "./schemas/common";

// 畫質（docs/specs/streaming.md §2）：房主用三條分段滑桿調整解析度、位元率、FPS。
// 房間只記住檔位（Quality）；實際送給編碼器的數值由 resolveQuality() 依片源算出。

/** 新房間的畫質：1080P、8 Mbps、30 FPS。 */
export const DEFAULT_QUALITY: Quality = {
  height: 1080,
  bitrate: 8_000_000,
  fps: 30,
};

/** 送給 sender 的編碼目標（streaming.md §2「解析成編碼參數」）。 */
export type EncodingTarget = {
  /**
   * 目標高度；片源比較矮時不放大（scaleResolutionDownBy 最小為 1）。
   * null：「原片」解析度，不縮放。傳輸層換片時依新 track 的高度重算（streaming.md §9）。
   */
  targetHeight: number | null;
  /** bps。 */
  maxBitrate: number;
  /** null：不限制，沿用片源幀率。 */
  maxFramerate: number | null;
};

/** 「原片位元率」量不到（片長未知等）時使用的位元率。 */
export const SOURCE_BITRATE_FALLBACK = 15_000_000;
/** 「原片位元率」的上限，避免極高碼率的原片把上傳塞滿。 */
export const SOURCE_BITRATE_MAX = 50_000_000;

/**
 * 由檔案大小與片長估計原片平均位元率（含音軌，bps）。量不到時回 null。
 */
export function estimateSourceBitrate(
  fileBytes: number,
  durationSeconds: number,
): number | null {
  if (!(fileBytes > 0) || !(durationSeconds > 0)) return null;
  if (!Number.isFinite(durationSeconds)) return null;
  return Math.round((fileBytes * 8) / durationSeconds);
}

/** 「原片位元率」實際使用的值：夾在上限內，量不到時用 SOURCE_BITRATE_FALLBACK。 */
export function sourceBitrateOrFallback(sourceBitrate: number | null): number {
  if (sourceBitrate === null || !(sourceBitrate > 0))
    return SOURCE_BITRATE_FALLBACK;
  return Math.min(sourceBitrate, SOURCE_BITRATE_MAX);
}

/** 把檔位解析成編碼參數。`sourceBitrate` 見 estimateSourceBitrate。 */
export function resolveQuality(
  quality: Quality,
  sourceBitrate: number | null,
): EncodingTarget {
  return {
    targetHeight: quality.height === "source" ? null : quality.height,
    maxBitrate:
      quality.bitrate === "source"
        ? sourceBitrateOrFallback(sourceBitrate)
        : quality.bitrate,
    maxFramerate: quality.fps === "source" ? null : quality.fps,
  };
}

/**
 * 實際送出的高度超過此值時，編碼改用 `maintain-resolution`（ADR 0003 D3）：
 * 房主選了高畫質，頻寬或 CPU 不夠時改掉幀，不降解析度。
 */
export const MAINTAIN_RESOLUTION_ABOVE_HEIGHT = 1080;

/** 實際送出的高度超過此值、位元率低於 HIGH_RESOLUTION_BITRATE_HINT 時，畫質面板提示調高位元率。 */
export const HIGH_RESOLUTION_HINT_ABOVE_HEIGHT = 1440;
export const HIGH_RESOLUTION_BITRATE_HINT = 25_000_000;

/**
 * 實際送出的高度：不超過片源（不放大）；`targetHeight` 為 null（原片）時就是片源高度。
 * 片源高度未知（0 或負值）時回 `targetHeight ?? 0`。
 */
export function sentVideoHeight(
  sourceHeight: number,
  targetHeight: number | null,
): number {
  if (!(sourceHeight > 0)) return targetHeight ?? 0;
  return targetHeight === null
    ? sourceHeight
    : Math.min(sourceHeight, targetHeight);
}

export type VideoEncodingPolicy = {
  /** ≥ 1；原片或片源較矮時為 1。 */
  scaleResolutionDownBy: number;
  degradationPreference: "maintain-framerate" | "maintain-resolution";
};

/** 依片源高度與目標高度算出縮放與降級策略（streaming.md §2，ADR 0003 D3）。p2p／relay 共用。 */
export function videoEncodingPolicy(
  sourceHeight: number,
  targetHeight: number | null,
): VideoEncodingPolicy {
  const scaleResolutionDownBy =
    targetHeight === null || !(sourceHeight > 0)
      ? 1
      : Math.max(1, sourceHeight / targetHeight);
  return {
    scaleResolutionDownBy,
    degradationPreference:
      sentVideoHeight(sourceHeight, targetHeight) >
      MAINTAIN_RESOLUTION_ABOVE_HEIGHT
        ? "maintain-resolution"
        : "maintain-framerate",
  };
}

export function sameQuality(a: Quality, b: Quality): boolean {
  return a.height === b.height && a.bitrate === b.bitrate && a.fps === b.fps;
}

export function sameEncodingTarget(a: EncodingTarget, b: EncodingTarget) {
  return (
    a.targetHeight === b.targetHeight &&
    a.maxBitrate === b.maxBitrate &&
    a.maxFramerate === b.maxFramerate
  );
}

/**
 * 讀取伺服器儲存的畫質。T-126 以前的房間存的是 `'smooth' | 'standard' | 'high'`，
 * 讀到無法解析的值一律回到預設。
 */
export function parseStoredQuality(value: unknown): Quality {
  const parsed = qualitySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_QUALITY;
}

export const AUDIO_MAX_BITRATE = 128_000;

/** P2P 預估總上傳量超過此值時提示房主（streaming.md §2）。 */
export const P2P_TOTAL_BITRATE_WARNING = 60_000_000;
