import { useEffect, useState, useSyncExternalStore } from "react";
import { Layout } from "../components/Layout";
import { Button, Card, Notice } from "../components/ui";
import { ViewerPlayer } from "../features/player";
import { HostSourcePlayer, useLocalSource } from "../features/source";
import {
  InviteCodeCard,
  MemberList,
  StreamSettings,
  useRoom,
} from "../features/room";
import type { HostPhase } from "../features/room/host-session-types";
import {
  forgetRoomIdentity,
  formatMbps,
  roomExit,
  uploadHint,
  type RoomView,
} from "../features/room/room-state";
import { ApiError } from "../lib/api";
import { navigate } from "../lib/router";
import type { ConnectionState } from "../lib/signal";
import { roomToken } from "../lib/storage";

type Room = ReturnType<typeof useRoom>;

/** 留在房間頁顯示的結束畫面（4000、驗證後的 4400）。要回首頁的情況見 roomExit。 */
function closedMessage(
  view: RoomView,
): { title: string; detail: string } | null {
  const c = view.connection;
  if (c.status !== "closed") return null;
  switch (c.reason) {
    case "replaced":
      return {
        title: "你在另一個分頁開了這個房間",
        detail: "同一個人只能在一個分頁使用。要在這裡繼續，請重新整理。",
      };
    case "bad_request":
      return {
        title: "網頁版本已更新",
        detail: "請重新整理頁面。",
      };
    default:
      return null;
  }
}

function ConnectionNotice({ connection }: { connection: ConnectionState }) {
  if (connection.status === "connecting") return <Notice>連線中…</Notice>;
  if (connection.status === "reconnecting") {
    return (
      <Notice tone="warning">
        連線中斷，正在重新連線（第 {connection.attempt} 次）…
      </Notice>
    );
  }
  return null;
}

function useActionError() {
  const [error, setError] = useState("");
  const run = (promise: Promise<unknown> | undefined) => {
    setError("");
    promise?.catch((e: unknown) =>
      setError(e instanceof ApiError ? e.message : "操作失敗，請稍後再試。"),
    );
  };
  return { error, run, clear: () => setError("") };
}

function hostTitle(phase: HostPhase, liveTitle: string | null) {
  switch (phase) {
    case "live":
      return `直播中：${liveTitle ?? ""}`;
    case "starting":
      return "開播中…";
    case "stopping":
      return "停止直播中…";
    case "switching":
      return "切換中…";
    case "waiting":
      return "直播暫停中";
    default:
      return "選擇要播放的影片";
  }
}

/**
 * 房主畫面。開播、停播、換片、切模式與重新驗證後恢復直播都交給 HostSession
 *（features/room/host-session.ts）；這裡只把片源與按鈕接上去。
 */
function HostView({
  room,
  host,
}: {
  room: Room;
  host: NonNullable<Room["host"]>;
}) {
  const { view, actions } = room;
  const session = useSyncExternalStore(host.subscribe, host.getView);
  // addtrack／removetrack 時 stream 物件不變，靠 onStreamChange 通知（streaming.md §1）。
  // 回呼由 useEffectEvent 包住，呼叫時拿到的是最新一次 render 的 source。
  const source = useLocalSource((stream) =>
    host.setSource({
      stream,
      status: source.check.status,
      title: source.title,
    }),
  );
  const { error, run } = useActionError();
  const { stream: sourceStream, title: sourceTitle } = source;
  const sourceStatus = source.check.status;
  // 換檔、檢查狀態或片名改變（含第一次通過檢查）。
  useEffect(() => {
    host.setSource({
      stream: sourceStream,
      status: sourceStatus,
      title: sourceTitle,
    });
  }, [host, sourceStream, sourceStatus, sourceTitle]);

  const ready = sourceStatus === "ready";
  const online = view.connection.status === "open";
  const viewers = view.members.filter(
    (m) => m.role === "member" && m.online,
  ).length;
  const { phase } = session;
  const busy =
    phase === "starting" || phase === "stopping" || phase === "switching";
  const upload = view.room
    ? uploadHint(view.room.mode, view.room.quality, viewers)
    : null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid content-start gap-4">
        <Card
          title={hostTitle(phase, view.stream.title)}
          action={
            session.intent ? (
              <Button
                variant="danger"
                disabled={phase === "stopping"}
                onClick={() => host.setIntent(false)}
              >
                停止直播
              </Button>
            ) : (
              <Button
                disabled={!ready || !online || busy}
                onClick={() => host.setIntent(true)}
              >
                {phase === "stopping" ? "停止中…" : "開始直播"}
              </Button>
            )
          }
        >
          {phase === "waiting" && (
            <div className="mb-3">
              <Notice tone="warning">
                {!online
                  ? view.connection.status === "connecting"
                    ? "正在連線並同步房間狀態，完成後會自動恢復直播。"
                    : "連線中斷，重新連上後會自動恢復直播。"
                  : ready
                    ? "正在與伺服器同步狀態，完成後會自動恢復直播。"
                    : sourceStatus === "idle"
                      ? "重新整理後要重新選擇影片。選好並通過檢查後，會自動恢復直播。"
                      : "影片還不能播放（檢查中或需要確認）。可以播放後會自動恢復直播。"}
              </Notice>
            </div>
          )}
          {phase === "switching" && (
            <div className="mb-3">
              <Notice>正在切換傳送方式，收看者會短暫中斷。</Notice>
            </div>
          )}
          {(phase === "idle" || phase === "waiting") && upload?.warn && (
            <div className="mb-3">
              <Notice tone="warning">
                預估上傳 {formatMbps(upload.total)}，超過 60
                Mbps，建議改用「流暢」畫質或「轉發」模式。
              </Notice>
            </div>
          )}
          <HostSourcePlayer source={source} />
          {!session.intent && (
            <p className="mt-3 text-sm text-zinc-500">
              選好影片並通過檢查後，按「開始直播」。直播期間可以隨時暫停、拖動進度或換片，朋友會看到一樣的畫面。
            </p>
          )}
        </Card>
        {session.error && (
          <Notice tone="error">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 wrap-anywhere">{session.error}</span>
              <button
                type="button"
                className="shrink-0 text-rose-200 underline-offset-2 hover:underline"
                onClick={() => host.clearError()}
              >
                關閉
              </button>
            </div>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      <aside className="grid content-start gap-4">
        {view.room?.inviteCode && (
          <InviteCodeCard
            inviteCode={view.room.inviteCode}
            inviteCodeVersion={view.room.inviteCodeVersion ?? 0}
            onRegenerate={actions.regenerateInviteCode}
          />
        )}
        {view.room && (
          <StreamSettings
            room={view.room}
            viewers={viewers}
            busy={busy}
            onModeChange={(mode) => host.setMode(mode)}
            onQualityChange={(quality) => host.setQuality(quality)}
            onLockedChange={(locked) => run(actions.updateRoom({ locked }))}
          />
        )}
        <MemberList
          members={view.members}
          youId={view.you?.memberId ?? ""}
          isHost
          memberStatus={view.memberStatus}
          onKick={(memberId) => run(actions.kick(memberId))}
        />
      </aside>
    </div>
  );
}

function ViewerView({ room }: { room: Room }) {
  const { view, viewer } = room;
  const host = view.members.find((m) => m.role === "host");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="grid grid-cols-[minmax(0,1fr)] content-start gap-3">
        {view.stream.live && view.stream.title && (
          <h2 className="font-medium wrap-anywhere text-white">
            {view.stream.title}
          </h2>
        )}
        {viewer && (
          <ViewerPlayer
            viewer={viewer}
            hostName={host?.nickname ?? null}
            hostOnline={host?.online ?? false}
          />
        )}
      </section>
      <aside className="grid content-start gap-4">
        <MemberList
          members={view.members}
          youId={view.you?.memberId ?? ""}
          isHost={false}
          memberStatus={{}}
          onKick={() => {}}
        />
      </aside>
    </div>
  );
}

export function RoomPage({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const { view } = room;
  const exit = room.corrupted
    ? { notice: "本機儲存的身份資料損壞了，請重新用邀請碼加入。" }
    : roomExit(view);
  const exitNotice = exit?.notice;

  // 房間關閉、被踢、身份失效：這份 token 已經沒用，清掉並回首頁顯示原因。
  // 只清本分頁用的那份，另一分頁可能已經換到新的憑證。
  const { token } = room;
  useEffect(() => {
    if (!exitNotice) return;
    forgetRoomIdentity(roomId, token);
    navigate("/", { replace: true, notice: exitNotice });
  }, [exitNotice, roomId, token]);

  if (exit) return null;

  if (!room.hasToken) {
    return (
      <Layout>
        <Card title="你還沒加入這個房間">
          <p className="mb-4 text-sm text-zinc-400">
            請向房主索取邀請碼或邀請連結。
          </p>
          <Button onClick={() => navigate("/")}>回首頁輸入邀請碼</Button>
        </Card>
      </Layout>
    );
  }

  const closed = closedMessage(view);
  if (closed) {
    return (
      <Layout>
        <Card title={closed.title}>
          <p className="mb-4 text-sm text-zinc-400">{closed.detail}</p>
          <div className="flex gap-2">
            <Button onClick={() => location.reload()}>重新整理</Button>
            <Button variant="secondary" onClick={() => navigate("/")}>
              回首頁
            </Button>
          </div>
        </Card>
      </Layout>
    );
  }

  return (
    <Layout wide>
      <div className="mb-4 grid gap-3">
        <ConnectionNotice connection={view.connection} />
        {view.lastError && <Notice tone="error">{view.lastError}</Notice>}
        {!roomToken.persisted(roomId) && (
          <Notice tone="warning">
            瀏覽器不允許儲存資料，重新整理或關閉分頁後會失去在這個房間的身份。
          </Notice>
        )}
      </div>
      {view.you?.role === "host" && room.host ? (
        <HostView room={room} host={room.host} />
      ) : view.you ? (
        <ViewerView room={room} />
      ) : null}
    </Layout>
  );
}
