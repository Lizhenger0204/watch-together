/** 畫質面板內的「Safari 模式」開關（房主本機，streaming.md §2「Safari 模式」）。 */
export const SAFARI_MODE_HINT =
  "改用軟體編碼，部分畫面細節較多但較吃 CPU；4K 會明顯掉幀";

export function SafariModeSwitch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="grid gap-1 border-t border-white/10 pt-3">
      <div className="flex items-center justify-between gap-3">
        <span
          id="safari-mode-label"
          className="text-xs font-semibold text-white/85"
        >
          Safari 模式
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="safari-mode-label"
          aria-describedby="safari-mode-hint"
          title="Safari 模式"
          onClick={() => onChange(!on)}
          className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none ${
            on ? "bg-[#0072b2]" : "bg-white/25"
          }`}
        >
          <span
            className={`size-5 rounded-full bg-white transition-transform ${
              on ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>
      <p id="safari-mode-hint" className="text-xs text-white/60">
        {SAFARI_MODE_HINT}
      </p>
    </div>
  );
}
