import { sameQuality, type Quality } from "@project/shared";
import { useState } from "react";
import {
  QUALITY_STEPS,
  maxStepIndex,
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
 * 播放器控制列「畫質」彈出面板（房主，streaming.md §2）：三條分段滑桿。
 * 拖曳時只改畫面上的草稿，放開（或鍵盤調整後放開按鍵）才送出；
 * 送出後草稿保留到伺服器廣播的畫質追上為止，避免滑桿跳回舊值。
 */
export function QualityPanel({
  quality,
  source,
  onChange,
}: {
  quality: Quality;
  /** 片源高度與估計位元率；還沒選片時為 null。 */
  source: { height: number; bitrate: number | null } | null;
  onChange: (quality: Quality) => void;
}) {
  const [draft, setDraft] = useState<Quality | null>(null);
  // 伺服器已採用草稿：清掉草稿（render 中依 props 調整 state，不需要 effect）。
  if (draft && sameQuality(draft, quality)) setDraft(null);
  const shown = draft ?? quality;
  const sourceHeight = source?.height ?? null;

  function commit() {
    if (draft && !sameQuality(draft, quality)) onChange(draft);
  }

  return (
    <div className="grid gap-4">
      {FIELDS.map(({ field, label }) => {
        const steps = QUALITY_STEPS[field] as readonly Quality[QualityField][];
        const max = maxStepIndex(field, sourceHeight);
        const index = stepIndex(field, shown, sourceHeight);
        const value = steps[index]!;
        const valueText = stepValueText(field, value, source?.bitrate ?? null);
        const id = `quality-${field}`;
        return (
          <div key={field} className="grid gap-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <label htmlFor={id} className="font-semibold text-white/80">
                {label}
              </label>
              <span className="text-white tabular-nums">
                {max < 0 ? `${sourceHeight}P（片源）` : valueText}
              </span>
            </div>
            <input
              id={id}
              type="range"
              className="player-range block w-full"
              min={0}
              max={steps.length - 1}
              step={1}
              value={index}
              disabled={max < 0}
              aria-valuetext={valueText}
              onChange={(event) =>
                setDraft(
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
            />
            <div
              aria-hidden
              className="flex justify-between text-xs text-white/60 tabular-nums"
            >
              {steps.map((step, i) => (
                <span
                  key={String(step)}
                  className={
                    i > max ? "text-white/25" : i === index ? "text-white" : ""
                  }
                >
                  {stepLabel(field, step)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {sourceHeight !== null && (
        <p className="text-xs text-white/60">
          片源 {sourceHeight}P，解析度不會超過片源。
        </p>
      )}
    </div>
  );
}
