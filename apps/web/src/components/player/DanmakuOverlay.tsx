import type { DanmakuItem } from "./danmaku-lanes";

/**
 * 播放器容器內的彈幕層（DESIGN.md §3：與控制列共用全螢幕容器，全螢幕時照常顯示）。
 * 一律以 React 純文字節點顯示，絕不使用 dangerouslySetInnerHTML。
 */
export function DanmakuOverlay({
  items,
  onDone,
}: {
  items: DanmakuItem[];
  onDone: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      aria-hidden
      data-testid="danmaku-overlay"
      className="danmaku-stage pointer-events-none absolute inset-x-0 top-0 bottom-14 z-[15] overflow-hidden select-none"
    >
      {items.map((item) => (
        <span
          key={item.id}
          className={`danmaku-item absolute left-full text-sm font-semibold whitespace-nowrap text-white sm:text-base ${
            item.isSelf ? "border-b border-sky-300/90" : ""
          }`}
          style={{
            top: `${item.topPercent}%`,
            animationDuration: `${item.durationMs}ms`,
          }}
          onAnimationEnd={() => onDone(item.id)}
        >
          {item.text}
        </span>
      ))}
    </div>
  );
}
