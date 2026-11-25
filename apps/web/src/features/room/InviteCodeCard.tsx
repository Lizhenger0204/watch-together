import {
  formatInviteCode,
  type RegenerateInviteCodeResponse,
} from "@project/shared";
import { Copy, RefreshCw, Share2 } from "lucide-react";
import { useState } from "react";
import { copyText } from "../../components/ui";
import { joinUrl } from "../../lib/router";

export function InviteCodeCard({
  inviteCode,
  inviteCodeVersion = 0,
  hostName,
  onlineCount,
  onRegenerate,
}: {
  inviteCode: string;
  inviteCodeVersion?: number;
  hostName?: string;
  onlineCount?: number;
  onRegenerate: () => Promise<RegenerateInviteCodeResponse> | undefined;
}) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  // 重產成功後記下這次換碼版本；畫面顯示該版本或更新的有效碼時才顯示成功提示。
  const [confirmedVersion, setConfirmedVersion] = useState<number | null>(null);
  const shown =
    confirmedVersion !== null && inviteCodeVersion >= confirmedVersion
      ? "已產生新的邀請碼"
      : feedback;

  async function copy(text: string, what: string) {
    setConfirmedVersion(null);
    setFeedback(
      (await copyText(text)) ? `已複製${what}` : "無法自動複製，請手動選取",
    );
  }

  async function regenerate() {
    if (
      !window.confirm(
        "重新產生後舊的邀請碼會失效（已在房內的人不受影響）。確定嗎？",
      )
    )
      return;
    setBusy(true);
    setConfirmedVersion(null);
    try {
      const result = await onRegenerate();
      if (!result) return;
      setFeedback("");
      setConfirmedVersion(result.inviteCodeVersion);
    } catch {
      setFeedback("重新產生失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="px-4 py-3.5">
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {hostName && (
            <p className="truncate text-sm text-zinc-900">
              <span className="font-semibold text-[#0072b2]">{hostName}</span>{" "}
              正在主持
            </p>
          )}
          {onlineCount !== undefined && (
            <p className="text-xs text-zinc-500">{onlineCount} 人在線</p>
          )}
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[#0072b2] transition-colors hover:bg-sky-50 focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none"
          onClick={() => void copy(joinUrl(inviteCode), "邀請連結")}
        >
          <Share2 className="size-3.5" strokeWidth={1.75} />
          複製邀請連結
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-sm border border-zinc-200 bg-[#f5f6f7] px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-zinc-500">邀請碼</span>
          <span
            className="font-mono text-sm font-semibold tracking-[0.14em] text-zinc-900 select-all"
            data-testid="invite-code"
          >
            {formatInviteCode(inviteCode)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="複製邀請碼"
            title="複製邀請碼"
            className="inline-flex size-7 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-white hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none"
            onClick={() => void copy(formatInviteCode(inviteCode), "邀請碼")}
          >
            <Copy className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="重新產生邀請碼"
            title="重新產生邀請碼"
            disabled={busy}
            className="inline-flex size-7 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-white hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void regenerate()}
          >
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <p className="mt-1.5 text-xs text-[#0072b2] empty:hidden" role="status">
        {shown}
      </p>
    </section>
  );
}
