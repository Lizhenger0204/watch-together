import type { ChatMessage } from "@project/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DanmakuScheduler,
  type DanmakuDensity,
  type DanmakuItem,
} from "./danmaku-lanes";
import { loadDanmakuPrefs, saveDanmakuPrefs } from "./danmaku-prefs";

/**
 * 將房間新增的聊天訊息轉成播放器彈幕佇列。
 * 關閉彈幕時立刻清空畫面；分頁在背景時略過新訊息，避免切回前景一次堆積重疊。
 */
export function useDanmakuFeed(messages: ChatMessage[], selfMemberId: string) {
  const [prefs, setPrefs] = useState(loadDanmakuPrefs);
  const [items, setItems] = useState<DanmakuItem[]>([]);
  const schedulerRef = useRef(new DanmakuScheduler());
  const seenIdsRef = useRef(new Set<string>(messages.map((m) => m.id)));

  const setEnabled = useCallback((enabled: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, enabled };
      saveDanmakuPrefs(next);
      return next;
    });
    if (!enabled) {
      schedulerRef.current.reset();
      setItems([]);
    }
  }, []);

  const setDensity = useCallback((density: DanmakuDensity) => {
    setPrefs((prev) => {
      const next = { ...prev, density };
      saveDanmakuPrefs(next);
      return next;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    const fresh: ChatMessage[] = [];
    for (const msg of messages) {
      if (!seenIdsRef.current.has(msg.id)) {
        seenIdsRef.current.add(msg.id);
        fresh.push(msg);
      }
    }
    if (seenIdsRef.current.size > 400) {
      seenIdsRef.current = new Set(messages.map((m) => m.id));
    }
    if (fresh.length === 0) return;
    if (!prefs.enabled) return;
    if (typeof document !== "undefined" && document.hidden) return;

    setItems((prev) => {
      const now = Date.now();
      const alive = prev.filter((item) => item.expiresAt > now);
      let activeCount = alive.length;
      const added: DanmakuItem[] = [];
      for (const msg of fresh) {
        const scheduled = schedulerRef.current.schedule({
          id: msg.id,
          text: msg.text,
          density: prefs.density,
          activeCount,
          now,
          isSelf: msg.memberId === selfMemberId,
        });
        if (scheduled) {
          added.push(scheduled);
          activeCount += 1;
        }
      }
      return added.length > 0 ? [...alive, ...added] : alive;
    });
  }, [messages, prefs.enabled, prefs.density, selfMemberId]);

  // 保險清理：分頁休眠或 CSS 動畫未觸發 onAnimationEnd 時，到期自動移除。
  useEffect(() => {
    if (items.length === 0) return;
    const earliest = Math.min(...items.map((item) => item.expiresAt));
    const delay = Math.max(50, earliest - Date.now());
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setItems((prev) => prev.filter((item) => item.expiresAt > now));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [items]);

  return {
    enabled: prefs.enabled,
    density: prefs.density,
    items,
    setEnabled,
    setDensity,
    removeItem,
  };
}
