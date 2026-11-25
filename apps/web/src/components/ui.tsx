import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

// 共用 UI 元件（DESIGN.md：藍白基本色、扁平低圓角、最多 4 種字號）。

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-[#0095d9] text-white hover:bg-[#007cb8] disabled:bg-zinc-200 disabled:text-zinc-400",
  secondary:
    "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 disabled:border-zinc-200 disabled:text-zinc-400",
  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-200 disabled:text-red-400",
  ghost:
    "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:text-zinc-300",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded px-3.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[#0095d9] focus-visible:ring-offset-1 focus-visible:outline-none disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
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
      className={`rounded-sm border border-zinc-200 bg-white p-5 ${className}`}
    >
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {/* 標題可能含片名（無空白的長檔名），要能斷行，不可撐寬版面 */}
          {title && (
            <h2 className="min-w-0 text-base font-semibold wrap-anywhere text-zinc-900">
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
      <span className="text-sm font-medium text-zinc-700">{label}</span>
      <input
        className="h-10 rounded border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[#0095d9] focus:ring-1 focus:ring-[#0095d9] focus:outline-none"
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
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-800",
  }[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-sm border px-3 py-2 text-sm ${color}`}
    >
      {children}
    </div>
  );
}

/** 兩到三個選項的扁平切換列（傳送方式、畫質）。 */
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
  const description = options.find((o) => o.value === value)?.description;
  return (
    <fieldset className="grid gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-xs font-medium text-zinc-600">
        {label}
      </legend>
      <div className="grid auto-cols-fr grid-flow-col gap-0.5 rounded border border-zinc-200 bg-[#f5f6f7] p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={`rounded-xs px-2 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[#0095d9] focus-visible:outline-none disabled:cursor-not-allowed ${
              option.value === value
                ? "bg-[#0095d9] text-white"
                : "text-zinc-600 hover:bg-white hover:text-zinc-900"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {description && <p className="text-xs text-zinc-500">{description}</p>}
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
