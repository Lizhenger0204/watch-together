import { NICKNAME_MAX_LENGTH, normalizeInviteCode } from "@project/shared";
import { useState, type FormEvent } from "react";
import { Button, Card, Notice, TextField } from "../components/ui";
import { ApiError, joinRoom } from "../lib/api";
import { navigate, roomPath } from "../lib/router";
import { roomToken, savedNickname } from "../lib/storage";

export function JoinForm({ initialCode = "" }: { initialCode?: string }) {
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
      const joined = await joinRoom(inviteCode, nickname.trim());
      savedNickname.set(nickname.trim());
      roomToken.set(joined.roomId, joined.memberToken);
      navigate(roomPath(joined.roomId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加入失敗，請稍後再試。");
      setBusy(false);
    }
  }

  return (
    <Card title="加入房間">
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
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
          maxLength={NICKNAME_MAX_LENGTH}
          value={nickname}
          onChange={(event) => setNickname(event.currentTarget.value)}
          required
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button
          type="submit"
          disabled={busy || !nickname.trim() || !code.trim()}
        >
          {busy ? "加入中…" : "加入"}
        </Button>
      </form>
    </Card>
  );
}
