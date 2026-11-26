import type { ChatMessage } from "@project/shared";
import { useState, type KeyboardEvent, type ReactNode } from "react";

export type SidebarTabItem<T extends string> = {
  id: T;
  label: string;
  badge?: number;
};

/** 分頁與面板互相引用的 id（`aria-controls`／`aria-labelledby`）。 */
export function sidebarTabIds(prefix: string, id: string) {
  return { tabId: `${prefix}-tab-${id}`, panelId: `${prefix}-panel-${id}` };
}

/** WAI-ARIA 分頁的鍵盤操作：左右鍵循環切換，Home／End 到頭尾；其他按鍵回傳 null。 */
export function nextTabIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * 側欄頂部的純文字底線分頁（DESIGN.md §3）。
 * 只有選中的分頁在 Tab 順序裡，方向鍵切換並移動焦點；每個分頁都要有一個 `SidebarTabPanel`（未選中的隱藏）。
 */
export function SidebarTabs<T extends string>({
  idPrefix,
  label,
  tabs,
  active,
  onChange,
}: {
  idPrefix: string;
  label: string;
  tabs: readonly SidebarTabItem<T>[];
  active: T;
  onChange: (id: T) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex((tab) => tab.id === active);
    const next = nextTabIndex(event.key, current, tabs.length);
    const target = next === null ? undefined : tabs[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.id);
    document.getElementById(sidebarTabIds(idPrefix, target.id).tabId)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className="flex shrink-0 border-b border-zinc-200 bg-white px-4"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const { tabId, panelId } = sidebarTabIds(idPrefix, tab.id);
        return (
          <button
            key={tab.id}
            id={tabId}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none focus-visible:ring-inset ${
              selected
                ? "border-[#0072b2] font-semibold text-[#0072b2]"
                : "border-transparent font-medium text-zinc-500 hover:text-zinc-900"
            }`}
          >
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="text-xs font-semibold text-[#0072b2] tabular-nums">
                {tab.badge > 99 ? "99+" : tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 分頁對應的面板。每個分頁的面板元素都一直存在，讓每個分頁的 `aria-controls` 都指得到；
 * 未選中的面板隱藏且不渲染內容（內容掛載時機與只渲染選中分頁時相同）。
 */
export function SidebarTabPanel({
  idPrefix,
  id,
  active,
  children,
}: {
  idPrefix: string;
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  const { tabId, panelId } = sidebarTabIds(idPrefix, id);
  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      hidden={!active}
      className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
    >
      {active && children}
    </div>
  );
}

/** 計算上次讀過聊天室之後新進的訊息數（聊天室可見時自動清零）。 */
export function countUnreadMessages(
  messages: readonly ChatMessage[],
  lastReadId: string | null,
): number {
  if (messages.length === 0) return 0;
  if (lastReadId === null) return messages.length;
  const index = messages.findIndex((m) => m.id === lastReadId);
  return index < 0 ? messages.length : messages.length - 1 - index;
}

export function useUnreadChat(
  messages: readonly ChatMessage[],
  visible: boolean,
): number {
  const [lastReadId, setLastReadId] = useState<string | null>(
    () => messages.at(-1)?.id ?? null,
  );
  const latestId = messages.at(-1)?.id ?? null;
  if (visible && latestId !== lastReadId) {
    setLastReadId(latestId);
  }
  return visible ? 0 : countUnreadMessages(messages, lastReadId);
}
