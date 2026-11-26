import { chatTextLength, type ChatMessage } from "@project/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DanmakuScheduler,
  type DanmakuDensity,
  type DanmakuItem,
} from "./danmaku-lanes";
import { loadDanmakuPrefs, saveDanmakuPrefs } from "./danmaku-prefs";

/** 軌道全滿時最多排隊幾則；超過時捨棄最舊的他人訊息。 */
const MAX_PENDING = 20;
/** 排隊超過這個時間才輪到的彈幕已經和聊天內容脫節，直接略過（聊天室仍看得到）。 */
const MAX_WAIT_MS = 5_000;

type Pending = { msg: ChatMessage; queuedAt: number };

/** 量不到時的後備值：舞台寬取視窗寬，每字約 16px（sm:text-base）。 */
const FALLBACK_STAGE_WIDTH = 960;
const FALLBACK_CHAR_WIDTH = 16;

/**
 * 將房間新增的聊天訊息轉成播放器彈幕佇列。
 * 軌道入口都有彈幕時先排隊，等軌道空出再發射，不會疊在同一位置。
 * 關閉彈幕時立刻清空畫面；分頁在背景時略過新訊息，避免切回前景一次堆積重疊。
 */
export function useDanmakuFeed(messages: ChatMessage[], selfMemberId: string) {
  const [prefs, setPrefs] = useState(loadDanmakuPrefs);
  const [items, setItems] = useState<DanmakuItem[]>([]);
  const itemsRef = useRef<DanmakuItem[]>([]);
  const schedulerRef = useRef(new DanmakuScheduler());
  const pendingRef = useRef<Pending[]>([]);
  const retryTimerRef = useRef<number | null>(null);
  const seenIdsRef = useRef(new Set<string>(messages.map((m) => m.id)));
  const prefsRef = useRef(prefs);
  const selfRef = useRef(selfMemberId);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  // 排在其他 effect 之前，讓 pump() 讀到這次渲染的密度與身份。
  useEffect(() => {
    prefsRef.current = prefs;
    selfRef.current = selfMemberId;
  }, [prefs, selfMemberId]);

  const commitItems = useCallback((next: DanmakuItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  // 用彈幕層裡同字型的隱形探針量文字寬度，排程才能算出真實的滑行速度與間距。
  const measure = useCallback((text: string) => {
    const stageWidth =
      stageRef.current?.clientWidth ||
      (typeof window === "undefined" ? 0 : window.innerWidth) ||
      FALLBACK_STAGE_WIDTH;
    let textWidth = 0;
    const probe = probeRef.current;
    if (probe) {
      probe.textContent = text;
      textWidth = probe.getBoundingClientRect().width;
      probe.textContent = "";
    }
    if (!(textWidth > 0))
      textWidth = chatTextLength(text) * FALLBACK_CHAR_WIDTH;
    return { stageWidth, textWidth };
  }, []);

  // 依序把排隊中的訊息放上畫面；遇到軌道全滿就停下，排一個計時器在最早空出時再試。
  // 排程在 setState 之外做，避免 StrictMode 重複執行 updater 時重複佔用軌道。
  const pump = useCallback(() => {
    clearRetry();
    const now = Date.now();
    const alive = itemsRef.current.filter((item) => item.expiresAt > now);
    const added: DanmakuItem[] = [];
    let retryAt: number | null = null;
    while (pendingRef.current.length > 0) {
      const { msg, queuedAt } = pendingRef.current[0]!;
      if (now - queuedAt > MAX_WAIT_MS) {
        pendingRef.current.shift();
        continue;
      }
      const result = schedulerRef.current.schedule({
        id: msg.id,
        text: msg.text,
        density: prefsRef.current.density,
        activeCount: alive.length + added.length,
        now,
        isSelf: msg.memberId === selfRef.current,
        ...measure(msg.text),
      });
      if (result.kind === "wait") {
        retryAt = result.retryAt;
        break;
      }
      pendingRef.current.shift();
      if (result.kind === "placed") added.push(result.item);
    }
    if (added.length > 0 || alive.length !== itemsRef.current.length) {
      commitItems([...alive, ...added]);
    }
    if (retryAt !== null) {
      retryTimerRef.current = window.setTimeout(
        pump,
        Math.max(16, retryAt - now),
      );
    }
  }, [clearRetry, commitItems, measure]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setPrefs((prev) => {
        const next = { ...prev, enabled };
        saveDanmakuPrefs(next);
        return next;
      });
      if (!enabled) {
        clearRetry();
        pendingRef.current = [];
        schedulerRef.current.reset();
        commitItems([]);
      }
    },
    [clearRetry, commitItems],
  );

  const setDensity = useCallback((density: DanmakuDensity) => {
    setPrefs((prev) => {
      const next = { ...prev, density };
      saveDanmakuPrefs(next);
      return next;
    });
  }, []);

  const removeItem = useCallback(
    (id: string) => {
      commitItems(itemsRef.current.filter((item) => item.id !== id));
    },
    [commitItems],
  );

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

    const now = Date.now();
    const queue = pendingRef.current;
    for (const msg of fresh) queue.push({ msg, queuedAt: now });
    while (queue.length > MAX_PENDING) {
      const index = queue.findIndex((p) => p.msg.memberId !== selfMemberId);
      queue.splice(index < 0 ? 0 : index, 1);
    }
    pump();
  }, [messages, prefs.enabled, selfMemberId, pump]);

  useEffect(() => clearRetry, [clearRetry]);

  // 保險清理：分頁休眠或 CSS 動畫未觸發 onAnimationEnd 時，到期自動移除。
  useEffect(() => {
    if (items.length === 0) return;
    const earliest = Math.min(...items.map((item) => item.expiresAt));
    const delay = Math.max(50, earliest - Date.now());
    const timer = window.setTimeout(() => {
      const now = Date.now();
      commitItems(itemsRef.current.filter((item) => item.expiresAt > now));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [items, commitItems]);

  return {
    enabled: prefs.enabled,
    density: prefs.density,
    items,
    stageRef,
    probeRef,
    setEnabled,
    setDensity,
    removeItem,
  };
}
