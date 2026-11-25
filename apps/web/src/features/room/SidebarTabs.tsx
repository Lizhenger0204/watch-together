import type { ChatMessage } from "@project/shared";
import { useState } from "react";

export type SidebarTabItem<T extends string> = {
  id: T;
  label: string;
  badge?: number;
};

/** 側欄頂部的純文字底線分頁（DESIGN.md §3）。 */
export function SidebarTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly SidebarTabItem<T>[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex shrink-0 border-b border-zinc-200 bg-white px-4"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
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
