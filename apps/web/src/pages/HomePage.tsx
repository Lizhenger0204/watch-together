import { NICKNAME_MAX_LENGTH } from "@project/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { Button, Notice, TextField } from "../components/ui";
import { ApiError, createRoom, getHealth } from "../lib/api";
import { navigate, readNotice, roomPath } from "../lib/router";
import { roomToken, savedNickname } from "../lib/storage";
import { JoinForm } from "./JoinForm";

function supportsHostCapture() {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    "captureStream" in HTMLVideoElement.prototype
  );
}

function CreateRoomPane({ canHost }: { canHost: boolean }) {
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
    <section className="flex flex-1 flex-col py-6 md:py-0 md:pr-8">
      <h2 className="mb-4 text-base font-semibold text-zinc-900">建立房間</h2>
      <form
        className="flex flex-1 flex-col gap-4"
        onSubmit={(event) => void submit(event)}
      >
        <TextField
          label="你的暱稱"
          placeholder="輸入要顯示的名稱"
          maxLength={NICKNAME_MAX_LENGTH}
          value={nickname}
          onChange={(event) => setNickname(event.currentTarget.value)}
          required
        />
        {!canHost && (
          <p className="text-xs text-zinc-500">
            此瀏覽器不支援播放端擷取，建立房間請改用桌面版 Chrome 或 Edge。
          </p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="mt-auto pt-2">
          <Button
            type="submit"
            className="w-full"
            disabled={busy || !nickname.trim()}
          >
            {busy ? "建立中…" : "建立房間"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ServiceStatus() {
  const [status, setStatus] = useState("正在檢查服務狀態…");
  const [healthy, setHealthy] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal).then(
      ({ protocolVersion }) => {
        setHealthy(true);
        setStatus(`服務正常（協定版本 ${protocolVersion}）`);
      },
      () => {
        if (!controller.signal.aborted) {
          setHealthy(false);
          setStatus("無法連上伺服器");
        }
      },
    );
    return () => controller.abort();
  }, []);
  return (
    <div className="mt-10 flex items-center gap-2 border-t border-zinc-200 pt-4 text-xs text-zinc-500">
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${
          healthy === true
            ? "bg-emerald-600"
            : healthy === false
              ? "bg-red-600"
              : "bg-zinc-300"
        }`}
      />
      <p role="status">{status}</p>
    </div>
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
  const [canHost] = useState(supportsHostCapture);
  return (
    <Layout>
      <ExitNotice />
      <h1 className="mb-1 text-xl font-bold text-zinc-900">一起看電影</h1>
      <p className="mb-8 text-sm text-zinc-500">
        房主播放本機影片，朋友用邀請碼加入同步觀看。
      </p>
      <div className="grid divide-y divide-zinc-200 border-t border-zinc-200 md:grid-cols-2 md:divide-x md:divide-y-0 md:border-t-0">
        <div className={`flex flex-col ${canHost ? "" : "order-2 md:order-1"}`}>
          <CreateRoomPane canHost={canHost} />
        </div>
        <div className={`flex flex-col ${canHost ? "" : "order-1 md:order-2"}`}>
          <JoinForm variant="pane" />
        </div>
      </div>
      <ServiceStatus />
    </Layout>
  );
}

export function JoinPage({ inviteCode }: { inviteCode: string }) {
  return (
    <Layout>
      <div className="mx-auto max-w-sm">
        <h1 className="mb-1 text-xl font-bold text-zinc-900">
          朋友邀請你一起看電影
        </h1>
        <p className="mb-6 text-sm text-zinc-500">輸入暱稱即可加入房間。</p>
        <div className="border-t border-zinc-200 pt-6">
          <JoinForm initialCode={inviteCode} autoFocusNickname />
        </div>
      </div>
    </Layout>
  );
}

export function NotFoundPage() {
  return (
    <Layout>
      <div className="mx-auto max-w-sm border-t border-zinc-200 pt-6">
        <h1 className="mb-2 text-xl font-bold text-zinc-900">找不到這個頁面</h1>
        <p className="mb-6 text-sm text-zinc-500">網址可能已失效或輸入有誤。</p>
        <Button onClick={() => navigate("/")}>回首頁</Button>
      </div>
    </Layout>
  );
}
