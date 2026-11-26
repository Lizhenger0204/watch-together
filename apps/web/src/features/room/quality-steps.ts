import {
  BITRATE_STEPS,
  FRAMERATE_STEPS,
  HIGH_RESOLUTION_BITRATE_HINT,
  HIGH_RESOLUTION_HINT_ABOVE_HEIGHT,
  MAINTAIN_RESOLUTION_ABOVE_HEIGHT,
  RESOLUTION_STEPS,
  resolveQuality,
  sentVideoHeight,
  sourceBitrateOrFallback,
  type Mode,
  type Quality,
} from "@project/shared";
import { formatMbps } from "./room-state";

// 畫質面板三條分段滑桿的純邏輯（streaming.md §2）。

export type QualityField = keyof Quality;

type Step<F extends QualityField> = Quality[F];

export const QUALITY_STEPS: { [F in QualityField]: readonly Step<F>[] } = {
  height: RESOLUTION_STEPS,
  bitrate: BITRATE_STEPS,
  fps: FRAMERATE_STEPS,
};

/** 實際送出的影像高度（不超過片源；原片時為片源高度；未知片源且原片時為 0）。 */
export function actualSentHeight(
  quality: Quality,
  sourceHeight: number | null,
): number {
  return sentVideoHeight(
    sourceHeight ?? 0,
    quality.height === "source" ? null : quality.height,
  );
}

/** 滑桿下方的刻度文字。 */
export function stepLabel<F extends QualityField>(
  field: F,
  step: Step<F>,
): string {
  if (step === "source") return "原片";
  if (field === "height") return `${step}P`;
  if (field === "bitrate") return `${(step as number) / 1_000_000}M`;
  return String(step);
}

/**
 * 滑桿右上角的目前值。
 * - 原片位元率附上估計值（與實際送出的上限一致，最高 50 Mbps）。
 * - 解析度「原片」顯示「原片（1608P）」，片源未知時只顯示「原片」。
 * - 解析度數字檔位高於片源時顯示實際送出的片源高度（例如「1000P（片源）」）。
 */
export function stepValueText<F extends QualityField>(
  field: F,
  step: Step<F>,
  sourceBitrate: number | null,
  sourceHeight: number | null = null,
): string {
  if (field === "bitrate") {
    if (step !== "source") return formatMbps(step as number);
    return sourceBitrate
      ? `原片（約 ${formatMbps(sourceBitrateOrFallback(sourceBitrate))}）`
      : "原片";
  }
  if (field === "fps") return step === "source" ? "原片" : `${step} FPS`;
  if (step === "source") {
    return sourceHeight ? `原片（${sourceHeight}P）` : "原片";
  }
  const height = step as number;
  return sourceHeight && sourceHeight < height
    ? `${sourceHeight}P（片源）`
    : `${height}P`;
}

/**
 * 解析度數字檔位中能選的最高索引（不超過片源高度）。
 * 片源未知時回傳最後一個數字檔位；片源比最低檔（720P）還矮時回 -1。
 */
export function maxNumericHeightIndex(sourceHeight: number | null): number {
  let index = -1;
  RESOLUTION_STEPS.forEach((step, i) => {
    if (typeof step !== "number") return;
    if (!sourceHeight || step <= sourceHeight) index = i;
  });
  return index;
}

/**
 * 單一檔位是否可選：只有解析度的數字檔位受片源限制（不超過片源）；
 * 解析度的「原片」與其他兩條滑桿永遠可選（streaming.md §2）。
 */
export function isStepSelectable(
  field: QualityField,
  index: number,
  sourceHeight: number | null,
): boolean {
  const steps = QUALITY_STEPS[field];
  if (index < 0 || index >= steps.length) return false;
  if (field !== "height" || !sourceHeight) return true;
  const step = RESOLUTION_STEPS[index];
  return (
    step === "source" || (typeof step === "number" && step <= sourceHeight)
  );
}

/**
 * 設定值在滑桿上的位置。**不夾到可選範圍**：房間設定可以高於片源
 * （例如設定 1080P、片源 1000P），此時滑桿停在 1080P，使用者往左拉到 900P 才有「變更」可以提交。
 */
export function stepIndex(field: QualityField, quality: Quality): number {
  const index = (QUALITY_STEPS[field] as readonly unknown[]).indexOf(
    quality[field],
  );
  return Math.max(0, index);
}

/**
 * 把滑桿位置換成新的畫質。
 * 解析度的「原片」永遠可選；數字檔位超出片源時夾回最高可選數字檔，
 * 沒有可選數字檔（片源 < 720P）時保持原設定（已選原片則維持原片）。
 */
export function withStep(
  quality: Quality,
  field: QualityField,
  index: number,
  sourceHeight: number | null,
): Quality {
  const steps = QUALITY_STEPS[field];
  const bounded = Math.max(0, Math.min(index, steps.length - 1));
  if (field !== "height" || !sourceHeight) {
    return { ...quality, [field]: steps[bounded] };
  }
  const target = RESOLUTION_STEPS[bounded]!;
  if (target === "source" || target <= sourceHeight) {
    return { ...quality, height: target };
  }
  const maxNumeric = maxNumericHeightIndex(sourceHeight);
  if (maxNumeric >= 0) {
    return { ...quality, height: RESOLUTION_STEPS[maxNumeric]! };
  }
  return quality;
}

/** 控制列畫質按鈕的文字：實際送出的解析度（原片顯示「原片（1608P）」或「原片」）。 */
export function qualityButtonLabel(
  quality: Quality,
  sourceHeight: number | null,
): string {
  const height = actualSentHeight(quality, sourceHeight);
  if (quality.height === "source") {
    return height > 0 ? `原片（${height}P）` : "原片";
  }
  return `${height}P`;
}

export type HighResolutionHints = {
  /** 實際送出高度 > 1080：顯示硬體編碼與 P2P 轉發建議。 */
  showStaticHint: boolean;
  /** P2P 且在線收看者 ≥ 2 人時，靜態提示改用警告樣式。 */
  warnStaticHint: boolean;
  /** 實際送出高度 > 1440 且實際位元率 < 25 Mbps：顯示「4K 建議 25 Mbps 以上」。 */
  showBitrateHint: boolean;
};

/** 畫質面板的高畫質靜態與位元率提示條件（streaming.md §2「高畫質提示」）。 */
export function highResolutionHints(
  quality: Quality,
  source: { height: number; bitrate: number | null } | null,
  mode: Mode,
  viewers: number,
): HighResolutionHints {
  const sentHeight = actualSentHeight(quality, source?.height ?? null);
  const resolvedBitrate = resolveQuality(
    quality,
    source?.bitrate ?? null,
  ).maxBitrate;
  const showStaticHint = sentHeight > MAINTAIN_RESOLUTION_ABOVE_HEIGHT;
  return {
    showStaticHint,
    warnStaticHint: showStaticHint && mode === "p2p" && viewers >= 2,
    showBitrateHint:
      sentHeight > HIGH_RESOLUTION_HINT_ABOVE_HEIGHT &&
      resolvedBitrate < HIGH_RESOLUTION_BITRATE_HINT,
  };
}
