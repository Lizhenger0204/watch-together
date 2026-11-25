import {
  formatInviteCode,
  type RegenerateInviteCodeResponse,
} from "@project/shared";
import { useState } from "react";
import { Button, Card, copyText } from "../../components/ui";
import { joinUrl } from "../../lib/router";

export function InviteCodeCard({
  inviteCode,
  inviteCodeVersion = 0,
  onRegenerate,
}: {
  inviteCode: string;
  inviteCodeVersion?: number;
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
    <Card title="邀請朋友">
      <p className="mb-2 text-sm text-zinc-400">把邀請碼或連結傳給朋友：</p>
      <p
        className="mb-4 font-mono text-3xl font-semibold tracking-[0.2em] text-white select-all"
        data-testid="invite-code"
      >
        {formatInviteCode(inviteCode)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => void copy(formatInviteCode(inviteCode), "邀請碼")}
        >
          複製邀請碼
        </Button>
        <Button
          variant="secondary"
          onClick={() => void copy(joinUrl(inviteCode), "邀請連結")}
        >
          複製邀請連結
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void regenerate()}
        >
          重新產生
        </Button>
      </div>
      <p className="mt-3 min-h-5 text-sm text-violet-300" role="status">
        {shown}
      </p>
    </Card>
  );
}
