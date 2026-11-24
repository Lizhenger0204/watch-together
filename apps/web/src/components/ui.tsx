import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

// 共用 UI 元件。顏色集中在這裡，頁面只組合元件。

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-violet-600 text-white hover:bg-violet-500 disabled:bg-violet-600/40",
  secondary:
    "bg-white/10 text-zinc-100 hover:bg-white/15 disabled:text-zinc-500",
  danger: "bg-rose-600/90 text-white hover:bg-rose-500 disabled:bg-rose-600/40",
  ghost: "text-zinc-300 hover:bg-white/10 hover:text-white",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({
  title,
  children,
  className = "",
  action,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border border-white/10 bg-zinc-900/70 p-5 ${className}`}
    >
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {/* 標題可能含片名（使用者的檔名，常是沒有空白的長字串），要能斷行，不可撐寬版面 */}
          {title && (
            <h2 className="min-w-0 text-base font-semibold wrap-anywhere text-white">
              {title}
            </h2>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function TextField({
  label,
  hint,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className={`grid gap-1.5 ${className}`}>
      <span className="text-sm text-zinc-300">{label}</span>
      <input
        className="h-11 rounded-lg border border-white/10 bg-zinc-950 px-3 text-base text-white placeholder:text-zinc-600 focus:border-violet-400 focus:outline-none"
        {...props}
      />
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "error";
  children: ReactNode;
}) {
  const color = {
    info: "border-sky-400/30 bg-sky-400/10 text-sky-100",
    warning: "border-amber-400/30 bg-amber-400/10 text-amber-100",
    error: "border-rose-400/30 bg-rose-400/10 text-rose-100",
  }[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-3 py-2 text-sm ${color}`}
    >
      {children}
    </div>
  );
}

/** 兩到三個選項的切換鈕（模式、畫質）。 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm text-zinc-300">{label}</legend>
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-zinc-950 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={`rounded-lg px-2 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none disabled:cursor-not-allowed ${
              option.value === value
                ? "bg-violet-600 text-white"
                : "text-zinc-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {options.find((o) => o.value === value)?.description && (
        <p className="text-xs leading-relaxed text-zinc-500">
          {options.find((o) => o.value === value)?.description}
        </p>
      )}
    </fieldset>
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
