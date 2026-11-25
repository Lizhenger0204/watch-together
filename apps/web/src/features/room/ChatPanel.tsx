import { CHAT_MAX_LENGTH, type ChatMessage } from "@project/shared";
import { SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api";
import { SignalDisconnectedError } from "../../lib/signal";

function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function chatErrorMessage(error: unknown): string {
  if (error instanceof SignalDisconnectedError) {
    return "連線中斷，訊息未送出。";
  }
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED") {
      return "發言太快了，請稍等幾秒再試。";
    }
    return error.message;
  }
  return "送出失敗，請稍後再試。";
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
  className = "",
}: {
  messages: ChatMessage[];
  youId: string;
  connected: boolean;
  onSend: (text: string) => Promise<void> | undefined;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el || messages.length === 0) return;
    const latest = messages[messages.length - 1];
    if (stickToBottomRef.current || latest?.memberId === youId) {
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [messages, youId]);

  const normalized = draft.replace(/[\r\n]+/g, " ").trim();
  const canSend =
    connected &&
    !sending &&
    normalized.length > 0 &&
    normalized.length <= CHAT_MAX_LENGTH;
  const showCounter = draft.length >= CHAT_MAX_LENGTH - 20;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    setError("");
    setSending(true);
    try {
      const promise = onSend(normalized);
      if (!promise) {
        setError("連線中斷，訊息未送出。");
        return;
      }
      await promise;
      setDraft("");
    } catch (e: unknown) {
      setError(chatErrorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      aria-label="聊天室"
      className={`flex min-h-0 flex-1 flex-col bg-white ${className}`}
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
            type="text"
            aria-label="輸入聊天訊息"
            value={draft}
            maxLength={CHAT_MAX_LENGTH}
            disabled={!connected || sending}
            placeholder={connected ? "說點什麼…" : "連線中…"}
            onChange={(event) => {
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
          <p className="text-right text-xs text-zinc-500 tabular-nums">
            {draft.length} / {CHAT_MAX_LENGTH}
          </p>
        )}
      </form>
    </section>
  );
}
