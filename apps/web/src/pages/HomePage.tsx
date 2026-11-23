import { NICKNAME_MAX_LENGTH } from "@project/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { Button, Card, Notice, TextField } from "../components/ui";
import { ApiError, createRoom, getHealth } from "../lib/api";
import { navigate, readNotice, roomPath } from "../lib/router";
import { roomToken, savedNickname } from "../lib/storage";
import { JoinForm } from "./JoinForm";

function CreateRoomCard() {
  const [nickname, setNickname] = useState(savedNickname.get);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const room = await createRoom(nickname.trim());
      // 先存 token（記憶體一定成功），再存暱稱。
      roomToken.set(room.roomId, room.hostToken);
      savedNickname.set(nickname.trim());
      navigate(roomPath(room.roomId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "建立失敗，請稍後再試。");
      setBusy(false);
    }
  }

  return (
    <Card title="建立房間">
      <p className="mb-4 text-sm text-zinc-400">
        你是放片的人：建立房間後選一部電影，再把邀請碼傳給朋友。
      </p>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <TextField
          label="你的暱稱"
          maxLength={NICKNAME_MAX_LENGTH}
          value={nickname}
          onChange={(event) => setNickname(event.currentTarget.value)}
          required
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" disabled={busy || !nickname.trim()}>
          {busy ? "建立中…" : "建立房間"}
        </Button>
      </form>
    </Card>
  );
}

function ServiceStatus() {
  const [status, setStatus] = useState("正在檢查服務狀態…");
  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal).then(
      ({ protocolVersion }) =>
        setStatus(`服務正常（協定版本 ${protocolVersion}）`),
      () => {
        if (!controller.signal.aborted) setStatus("無法連上伺服器");
      },
    );
    return () => controller.abort();
  }, []);
  return (
    <p role="status" className="mt-10 text-xs text-zinc-600">
      {status}
    </p>
  );
}

/** 從房間被送回首頁時（房間關閉、被踢、身份失效）顯示原因。 */
function ExitNotice() {
  const [notice] = useState(() => readNotice(history.state));
  useEffect(() => {
    // 顯示一次就好，重新整理首頁不要再出現。
    if (notice) history.replaceState(null, "", location.pathname);
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="mb-6">
      <Notice tone="warning">{notice}</Notice>
    </div>
  );
}

export function HomePage() {
  return (
    <Layout>
      <ExitNotice />
      <h1 className="mb-2 text-2xl font-bold text-white sm:text-3xl">
        一起看電影
      </h1>
      <p className="mb-8 text-zinc-400">
        房主播放電腦裡的影片，朋友用邀請碼加入，就能同步觀看。
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        <CreateRoomCard />
        <JoinForm />
      </div>
      <ServiceStatus />
    </Layout>
  );
}

export function JoinPage({ inviteCode }: { inviteCode: string }) {
  return (
    <Layout>
      <h1 className="mb-6 text-2xl font-bold text-white">
        朋友邀請你一起看電影
      </h1>
      <div className="max-w-md">
        <JoinForm initialCode={inviteCode} />
      </div>
    </Layout>
  );
}

export function NotFoundPage() {
  return (
    <Layout>
      <Card title="找不到這個頁面">
        <Button onClick={() => navigate("/")}>回首頁</Button>
      </Card>
    </Layout>
  );
}
