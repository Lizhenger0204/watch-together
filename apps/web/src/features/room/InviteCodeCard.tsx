import { formatInviteCode } from "@project/shared";
import { useState } from "react";
import { Button, Card, copyText } from "../../components/ui";
import { joinUrl } from "../../lib/router";

export function InviteCodeCard({
  inviteCode,
  onRegenerate,
}: {
  inviteCode: string;
  onRegenerate: () => Promise<unknown> | undefined;
}) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  // 重產成功、等畫面換掉的舊碼。REST 回應可能被較新的推送取代，畫面真的換成新碼才提示成功。
  const [replacing, setReplacing] = useState<string | null>(null);
  const shown =
    replacing !== null && inviteCode !== replacing
      ? "已產生新的邀請碼"
      : feedback;

  async function copy(text: string, what: string) {
    setReplacing(null);
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
    const before = inviteCode;
    setBusy(true);
    setReplacing(null);
    try {
      await onRegenerate();
      setFeedback("");
      setReplacing(before);
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
