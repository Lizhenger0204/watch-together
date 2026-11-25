import {
  BITRATE_STEPS,
  FRAMERATE_STEPS,
  RESOLUTION_STEPS,
  sourceBitrateOrFallback,
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
 * 滑桿右上角的目前值。原片位元率附上估計值（與實際送出的上限一致，最高 50 Mbps）。
 * 解析度的設定高於片源時顯示實際送出的片源高度，和可選的檔位區分開來
 * （例如設定 1080P、片源 1000P：顯示「1000P（片源）」，可選檔位只有 720P／900P）。
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
  const height = step as number;
  return sourceHeight && sourceHeight < height
    ? `${sourceHeight}P（片源）`
    : `${height}P`;
}

/**
 * 能選的最高檔位索引。只有解析度受片源限制（不超過片源高度）；
 * 片源未知時全部可選，片源比最低檔還矮時回 -1（整條停用）。
 */
export function maxStepIndex(
  field: QualityField,
  sourceHeight: number | null,
): number {
  const steps = QUALITY_STEPS[field];
  if (field !== "height" || !sourceHeight) return steps.length - 1;
  let index = -1;
  RESOLUTION_STEPS.forEach((height, i) => {
    if (height <= sourceHeight) index = i;
  });
  return index;
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

/** 把滑桿位置換成新的畫質（超出可選範圍時夾到最高可選檔位）。 */
export function withStep(
  quality: Quality,
  field: QualityField,
  index: number,
  sourceHeight: number | null,
): Quality {
  const steps = QUALITY_STEPS[field];
  const max = maxStepIndex(field, sourceHeight);
  const clamped = Math.max(0, Math.min(index, max));
  return { ...quality, [field]: steps[clamped] };
}

/** 控制列畫質按鈕的文字：實際送出的解析度（不超過片源）。 */
export function qualityButtonLabel(
  quality: Quality,
  sourceHeight: number | null,
): string {
  const height =
    sourceHeight && sourceHeight < quality.height
      ? sourceHeight
      : quality.height;
  return `${height}P`;
}
