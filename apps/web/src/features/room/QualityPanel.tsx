import type { Quality } from "@project/shared";
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
 * 拖曳時只改畫面上的草稿，放開（或鍵盤調整後放開按鍵、失去焦點）才送出。
 * 送出後由房間層追蹤「最後的選擇」（`pending`），面板顯示它直到房間廣播追上為止；
 * 請求被拒或逾時時 `pending` 會清掉，面板自動回到房間真實的畫質，不需要重開面板。
 */
export function QualityPanel({
  quality,
  pending,
  source,
  onChange,
}: {
  /** 房間目前的畫質（最近一次廣播）。 */
  quality: Quality;
  /** 房主最後一次選擇、尚未被廣播追上的畫質。 */
  pending: Quality | null;
  /** 片源高度與估計位元率；還沒選片時為 null。 */
  source: { height: number; bitrate: number | null } | null;
  onChange: (quality: Quality) => void;
}) {
  // 只在拖曳／按鍵調整到放開之前存在。
  const [drag, setDrag] = useState<Quality | null>(null);
  const shown = drag ?? pending ?? quality;
  const sourceHeight = source?.height ?? null;

  function commit() {
    if (!drag) return;
    setDrag(null);
    onChange(drag);
  }

  return (
    <div className="grid gap-4">
      {FIELDS.map(({ field, label }) => {
        const steps = QUALITY_STEPS[field] as readonly Quality[QualityField][];
        const max = maxStepIndex(field, sourceHeight);
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
          {shown.height > sourceHeight ? "目前依片源高度送出。" : ""}
        </p>
      )}
    </div>
  );
}
