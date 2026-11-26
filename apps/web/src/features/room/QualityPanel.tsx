import type { Mode, Quality } from "@project/shared";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { ENCODER_LAG_MESSAGE } from "./encoder-health";
import {
  QUALITY_STEPS,
  highResolutionHints,
  isStepSelectable,
  stepIndex,
  stepLabel,
  stepValueText,
  withStep,
  type QualityField,
} from "./quality-steps";

const FIELDS: { field: QualityField; label: string }[] = [
  { field: "height", label: "解析度" },
  { field: "bitrate", label: "位元率" },
  { field: "fps", label: "FPS" },
];

/**
 * 播放器控制列「畫質」彈出面板（房主，streaming.md §2）：三條分段滑桿與高畫質提示。
 * 拖曳時只改畫面上的草稿，放開（或鍵盤調整後放開按鍵、失去焦點）才送出。
 * 送出後由房間層追蹤「最後的選擇」（`pending`），面板顯示它直到房間廣播追上為止；
 * 請求被拒或逾時時 `pending` 會清掉，面板自動回到房間真實的畫質，不需要重開面板。
 */
export function QualityPanel({
  quality,
  pending,
  source,
  mode,
  viewers,
  encoderLagging,
  onChange,
}: {
  /** 房間目前的畫質（最近一次廣播）。 */
  quality: Quality;
  /** 房主最後一次選擇、尚未被廣播追上的畫質。 */
  pending: Quality | null;
  /** 片源高度與估計位元率；還沒選片時為 null。 */
  source: { height: number; bitrate: number | null } | null;
  /** 房間目前的傳送方式（P2P 多人高畫質提示用）。 */
  mode: Mode;
  /** 目前在線收看人數（P2P 且 ≥ 2 人時高畫質提示用警告樣式）。 */
  viewers: number;
  /** 房主端編碼器連續 10 秒跟不上（streaming.md §2）。 */
  encoderLagging: boolean;
  onChange: (quality: Quality) => void;
}) {
  // 只在拖曳／按鍵調整到放開之前存在。
  const [drag, setDrag] = useState<Quality | null>(null);
  const shown = drag ?? pending ?? quality;
  const sourceHeight = source?.height ?? null;
  const hints = highResolutionHints(shown, source, mode, viewers);

  function commit() {
    if (!drag) return;
    setDrag(null);
    onChange(drag);
  }

  return (
    <div className="grid gap-4">
      {encoderLagging && (
        <p
          role="status"
          className="flex items-start gap-1.5 rounded-sm border border-amber-400/50 bg-amber-500/15 px-2.5 py-2 text-xs text-amber-200"
        >
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-amber-400"
            strokeWidth={1.75}
          />
          <span>{ENCODER_LAG_MESSAGE}</span>
        </p>
      )}
      {FIELDS.map(({ field, label }) => {
        const steps = QUALITY_STEPS[field] as readonly Quality[QualityField][];
        const index = stepIndex(field, shown);
        const value = steps[index]!;
        const valueText = stepValueText(
          field,
          value,
          source?.bitrate ?? null,
          sourceHeight,
        );
        const id = `quality-${field}`;
        return (
          <div key={field} className="grid gap-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <label htmlFor={id} className="font-semibold text-white/80">
                {label}
              </label>
              <span className="text-white tabular-nums">{valueText}</span>
            </div>
            <input
              id={id}
              type="range"
              className="player-range block w-full"
              min={0}
              max={steps.length - 1}
              step={1}
              value={index}
              aria-valuetext={valueText}
              onChange={(event) =>
                setDrag(
                  withStep(
                    shown,
                    field,
                    event.currentTarget.valueAsNumber,
                    sourceHeight,
                  ),
                )
              }
              onPointerUp={commit}
              onKeyUp={commit}
              onBlur={commit}
            />
            <div
              aria-hidden
              className="flex justify-between text-xs text-white/60 tabular-nums"
            >
              {steps.map((step, i) => (
                <span
                  key={String(step)}
                  className={
                    !isStepSelectable(field, i, sourceHeight)
                      ? "text-white/25"
                      : i === index
                        ? "text-white"
                        : ""
                  }
                >
                  {stepLabel(field, step)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {hints.showBitrateHint && (
        <p className="rounded-sm border border-amber-400/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200">
          4K 建議 25 Mbps 以上
        </p>
      )}
      {hints.showStaticHint && (
        <p
          role={hints.warnStaticHint ? "status" : undefined}
          data-tone={hints.warnStaticHint ? "warning" : "info"}
          className={
            hints.warnStaticHint
              ? "rounded-sm border border-amber-400/50 bg-amber-500/15 px-2.5 py-2 text-xs text-amber-200"
              : "rounded-sm border border-white/15 bg-white/5 px-2.5 py-2 text-xs text-white/75"
          }
        >
          高畫質需要房主電腦有硬體編碼。P2P
          每位收看者各編碼一次，建議改用『轉發』。
        </p>
      )}
      {sourceHeight !== null && (
        <p className="text-xs text-white/60">
          片源 {sourceHeight}P，解析度不會超過片源。
          {shown.height !== "source" && shown.height > sourceHeight
            ? "目前依片源高度送出。"
            : ""}
        </p>
      )}
    </div>
  );
}
