import { DANMAKU_PRESETS, type DanmakuDensity } from "./danmaku-lanes";

/**
 * 播放器控制列「彈幕」彈出面板：開關與密度（少／中／多）。
 * 與畫質面板共用深色實底風格（DESIGN.md §3）。
 */
export function DanmakuPanel({
  enabled,
  density,
  onEnabledChange,
  onDensityChange,
}: {
  enabled: boolean;
  density: DanmakuDensity;
  onEnabledChange: (enabled: boolean) => void;
  onDensityChange: (density: DanmakuDensity) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-white/85">顯示彈幕</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="顯示彈幕"
          onClick={() => onEnabledChange(!enabled)}
          className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none ${
            enabled ? "bg-[#0072b2]" : "bg-white/25"
          }`}
        >
          <span
            className={`size-5 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <div className="grid gap-1.5">
        <span className="text-xs font-semibold text-white/85">彈幕密度</span>
        <div className="grid grid-cols-3 gap-1">
          {DANMAKU_PRESETS.map((preset) => {
            const active = preset.value === density;
            return (
              <button
                key={preset.value}
                type="button"
                aria-pressed={active}
                disabled={!enabled}
                onClick={() => onDensityChange(preset.value)}
                className={`rounded-xs py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? "bg-[#0072b2] text-white"
                    : "bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
