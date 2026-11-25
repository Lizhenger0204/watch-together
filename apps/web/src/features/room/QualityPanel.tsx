import { QUALITY_PRESETS, type Quality } from "@project/shared";
import { formatMbps } from "./room-state";

const QUALITY_OPTIONS = Object.keys(QUALITY_PRESETS) as Quality[];

/** 播放器控制列的畫質按鈕文字。 */
export function qualityLabel(quality: Quality): string {
  return QUALITY_PRESETS[quality].label;
}

/** 播放器控制列「畫質」彈出面板的內容（房主）。 */
export function QualityPanel({
  quality,
  onChange,
}: {
  quality: Quality;
  onChange: (quality: Quality) => void;
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="mb-1.5 text-xs font-semibold text-white/70">
        畫質
      </legend>
      {QUALITY_OPTIONS.map((value) => {
        const preset = QUALITY_PRESETS[value];
        const selected = value === quality;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            className={`flex items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none ${
              selected ? "bg-[#0072b2] text-white" : "hover:bg-white/10"
            }`}
            onClick={() => {
              if (!selected) onChange(value);
            }}
          >
            <span>{preset.label}</span>
            <span className="text-xs text-white/70">
              {preset.targetHeight}P・{formatMbps(preset.maxBitrate)}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}
