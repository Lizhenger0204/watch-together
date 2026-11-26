import {
  CHAT_MAX_LENGTH,
  CHAT_RAW_MAX_LENGTH,
  chatTextLength,
  normalizeChatText,
  type ChatMessage,
} from "@project/shared";
import { SendHorizontal } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { restoreUnsentDraft } from "./chat-draft";
import { CHAT_NOT_SENT, chatErrorMessage } from "./chat-errors";

function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 房間聊天室（T-127，DESIGN.md §1、§3）。
 * 所有訊息一律以純文字顯示，不保留進房前的歷史紀錄。
 */
export function ChatPanel({
  messages,
  youId,
  connected,
  onSend,
  visible = true,
  className = "",
}: {
  messages: ChatMessage[];
  youId: string;
  connected: boolean;
  onSend: (text: string) => Promise<void> | undefined;
  /** 所在分頁是否顯示。隱藏時保持掛載（草稿與閱讀位置都保留），切回時還原捲動位置。 */
  visible?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  const savedScrollTopRef = useRef(0);

  function handleScroll() {
    const el = listRef.current;
    if (!el || !visible) return;
    savedScrollTopRef.current = el.scrollTop;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  }

  // 切回聊天分頁：原本停在底部就跟到最新，否則回到離開時的閱讀位置。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !visible) return;
    el.scrollTop = stickToBottomRef.current
      ? el.scrollHeight
      : savedScrollTopRef.current;
  }, [visible]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !visible || messages.length === 0) return;
    const latest = messages[messages.length - 1];
    if (stickToBottomRef.current || latest?.memberId === youId) {
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [messages, youId, visible]);

  const normalized = normalizeChatText(draft);
  const length = chatTextLength(normalized);
  const rawTooLong = chatTextLength(draft) > CHAT_RAW_MAX_LENGTH;
  const tooLong = length > CHAT_MAX_LENGTH || rawTooLong;
  const canSend = connected && !sending && length > 0 && !tooLong;
  const showCounter = length >= CHAT_MAX_LENGTH - 20 || rawTooLong;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    // 用滑鼠按送出時焦點在按鈕上，按鈕送出期間會停用，把焦點留在輸入框才能接著打字。
    inputRef.current?.focus();
    setError("");
    setSending(true);
    // 送出當下就清空輸入框，等確認期間可以接著打下一則；
    // 失敗時再把這次的文字放回前面，成功時輸入框只剩新打的字，不會殘留已送出的文字。
    const sentDraft = draft;
    setDraft("");
    try {
      const promise = onSend(normalized);
      if (!promise) {
        setDraft((current) => restoreUnsentDraft(sentDraft, current));
        setError(CHAT_NOT_SENT);
        return;
      }
      await promise;
    } catch (e: unknown) {
      setDraft((current) => restoreUnsentDraft(sentDraft, current));
      setError(chatErrorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      aria-label="聊天室"
      className={`flex min-h-0 flex-col bg-white ${className}`}
    >
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-[#f5f6f7] px-4 py-3"
      >
        {messages.length === 0 ? (
          <p className="py-8 text-center text-xs text-zinc-500">還沒有訊息</p>
        ) : (
          <ul className="grid gap-2.5">
            {messages.map((msg) => {
              const isSelf = msg.memberId === youId;
              return (
                <li key={msg.id} className="grid gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold text-zinc-800">
                      {msg.nickname}
                      {msg.role === "host" && (
                        <span className="ml-1.5 font-medium text-[#0072b2]">
                          房主
                        </span>
                      )}
                      {isSelf && (
                        <span className="ml-1 font-normal text-zinc-500">
                          （你）
                        </span>
                      )}
                    </span>
                    <time className="shrink-0 text-xs text-zinc-500 tabular-nums">
                      {formatClock(msg.sentAt)}
                    </time>
                  </div>
                  <p className="text-sm wrap-anywhere text-zinc-900">
                    {msg.text}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="grid gap-1.5 border-t border-zinc-200 bg-white p-3"
      >
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            aria-label="輸入聊天訊息"
            value={draft}
            aria-invalid={tooLong || undefined}
            placeholder={connected ? "說點什麼…" : "連線中…"}
            onChange={(event) => {
              // 不用 maxLength 截斷（UTF-16 長度，也會吃掉送出失敗時放回的草稿）；超過上限時停用送出並提示。
              setDraft(event.currentTarget.value);
              if (error) setError("");
            }}
            className="h-9 min-w-0 flex-1 rounded border border-zinc-200 bg-[#f5f6f7] px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[#0072b2] focus:bg-white focus:ring-1 focus:ring-[#0072b2] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="submit"
            aria-label="送出訊息"
            title="送出"
            disabled={!canSend}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded bg-[#0072b2] text-white transition-colors hover:bg-[#005a8d] focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:ring-offset-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
          >
            <SendHorizontal className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        {showCounter && (
          <p
            className={`text-right text-xs tabular-nums ${tooLong ? "text-red-600" : "text-zinc-500"}`}
          >
            {rawTooLong
              ? `含空白超過 ${CHAT_RAW_MAX_LENGTH} 字，請刪減後再送出`
              : `${length} / ${CHAT_MAX_LENGTH}`}
            {!rawTooLong && tooLong && "（超過上限，請刪減後再送出）"}
          </p>
        )}
      </form>
    </section>
  );
}
