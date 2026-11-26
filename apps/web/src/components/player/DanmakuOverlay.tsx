import type { Ref } from "react";
import type { DanmakuItem } from "./danmaku-lanes";

/** 彈幕文字的字型樣式；量寬用的探針與實際彈幕共用，確保量到的寬度就是畫面上的寬度。 */
const DANMAKU_TEXT_CLASS =
  "text-sm font-semibold whitespace-nowrap sm:text-base";

/**
 * 播放器容器內的彈幕層（DESIGN.md §3：與控制列共用全螢幕容器，全螢幕時照常顯示）。
 * 一律以 React 純文字節點顯示，絕不使用 dangerouslySetInnerHTML。
 * 舞台與量寬探針一直存在，讓排程在發射前就能量到舞台寬度與文字寬度。
 */
export function DanmakuOverlay({
  items,
  onDone,
  stageRef,
  probeRef,
}: {
  items: DanmakuItem[];
  onDone: (id: string) => void;
  stageRef?: Ref<HTMLDivElement>;
  probeRef?: Ref<HTMLSpanElement>;
}) {
  return (
    <div
      ref={stageRef}
      aria-hidden
      data-testid="danmaku-overlay"
      className="danmaku-stage pointer-events-none absolute inset-x-0 top-0 bottom-14 z-[15] overflow-hidden select-none"
    >
      <span
        ref={probeRef}
        className={`invisible absolute top-0 left-0 ${DANMAKU_TEXT_CLASS}`}
      />
      {items.map((item) => (
        <span
          key={item.id}
          className={`danmaku-item absolute left-full text-white ${DANMAKU_TEXT_CLASS} ${
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
