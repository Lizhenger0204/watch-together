import { NICKNAME_MAX_LENGTH, normalizeInviteCode } from "@project/shared";
import { useState, type FormEvent } from "react";
import { Button, Notice, TextField } from "../components/ui";
import { joinKeepingIdentity } from "../features/room/identity";
import { ApiError } from "../lib/api";
import { navigate, roomPath } from "../lib/router";
import { savedNickname } from "../lib/storage";

export function JoinForm({
  initialCode = "",
  variant = "standalone",
  autoFocusNickname = false,
}: {
  initialCode?: string;
  variant?: "pane" | "standalone";
  autoFocusNickname?: boolean;
}) {
  const [code, setCode] = useState(initialCode);
  const [nickname, setNickname] = useState(savedNickname.get);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const inviteCode = normalizeInviteCode(code);
    if (!inviteCode) {
      setError("邀請碼是 8 個英文字母或數字，例如 ABCD-EFGH。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // 已經有這一房的有效身份（例如房主開了自己的邀請連結）就沿用，不覆寫。
      const joined = await joinKeepingIdentity(inviteCode, nickname.trim());
      savedNickname.set(nickname.trim());
      navigate(roomPath(joined.roomId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加入失敗，請稍後再試。");
      setBusy(false);
    }
  }

  return (
    <section
      className={
        variant === "pane"
          ? "flex h-full flex-col pt-6 md:pt-0 md:pl-8"
          : "grid gap-4"
      }
    >
      {variant === "pane" && (
        <h2 className="mb-4 text-base font-semibold text-zinc-900">加入房間</h2>
      )}
      <form
        className="flex flex-1 flex-col gap-4"
        onSubmit={(event) => void submit(event)}
      >
        <TextField
          label="邀請碼"
          placeholder="ABCD-EFGH"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
          required
        />
        <TextField
          label="你的暱稱"
          placeholder="輸入要顯示的名稱"
          maxLength={NICKNAME_MAX_LENGTH}
          autoFocus={autoFocusNickname}
          value={nickname}
          onChange={(event) => setNickname(event.currentTarget.value)}
          required
        />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="mt-auto pt-2">
          <Button
            type="submit"
            variant={variant === "pane" ? "secondary" : "primary"}
            className="w-full"
            disabled={busy || !nickname.trim() || !code.trim()}
          >
            {busy ? "加入中…" : "加入"}
          </Button>
        </div>
      </form>
    </section>
  );
}
