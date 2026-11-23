import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Button, Card, Notice } from "../components/ui";
import { HostSourcePlayer, useLocalSource } from "../features/source";
import {
  InviteCodeCard,
  MemberList,
  StreamSettings,
  useRoom,
} from "../features/room";
import type { RoomView } from "../features/room/room-state";
import { ApiError } from "../lib/api";
import { navigate } from "../lib/router";
import type { ConnectionState } from "../lib/signal";

type Room = ReturnType<typeof useRoom>;

function closedMessage(
  view: RoomView,
): { title: string; detail: string; reload?: boolean } | null {
  const c = view.connection;
  if (
    view.closedBy === "kicked" ||
    (c.status === "closed" && c.reason === "kicked")
  ) {
    return {
      title: "你已被房主請出房間",
      detail: "如果是誤會，請向房主要新的邀請碼。",
    };
  }
  if (view.closedBy || (c.status === "closed" && c.reason === "room_closed")) {
    return {
      title: "房間已關閉",
      detail: "房間閒置太久或已超過 24 小時。請房主重新建立房間。",
    };
  }
  if (c.status !== "closed") return null;
  switch (c.reason) {
    case "unauthorized":
      return { title: "身份已失效", detail: "請重新用邀請碼加入房間。" };
    case "replaced":
      return {
        title: "你在另一個分頁開了這個房間",
        detail: "同一個人只能在一個分頁觀看。",
        reload: true,
      };
    case "bad_request":
      return {
        title: "網頁版本已更新",
        detail: "請重新整理頁面。",
        reload: true,
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

function HostView({ room }: { room: Room }) {
  const { view, actions } = room;
  const source = useLocalSource();
  const { error, run } = useActionError();
  const { stream } = view;
  const ready = source.check.status === "ready";
  const online = view.connection.status === "open";
  const viewers = view.members.filter(
    (m) => m.role === "member" && m.online,
  ).length;

  // 直播中換片：新片檢查通過後更新片名。
  useEffect(() => {
    if (stream.live && ready && source.title && source.title !== stream.title) {
      void actions.setStream(true, source.title)?.catch(() => {});
    }
  }, [stream.live, stream.title, ready, source.title, actions]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid content-start gap-4">
        <Card
          title={
            stream.live ? `直播中：${stream.title ?? ""}` : "選擇要播放的影片"
          }
          action={
            stream.live ? (
              <Button
                variant="danger"
                disabled={!online}
                onClick={() => run(actions.setStream(false, null))}
              >
                停止直播
              </Button>
            ) : (
              <Button
                disabled={!ready || !online}
                onClick={() => run(actions.setStream(true, source.title))}
              >
                開始直播
              </Button>
            )
          }
        >
          <HostSourcePlayer source={source} />
          {!stream.live && (
            <p className="mt-3 text-sm text-zinc-500">
              選好影片並通過檢查後，按「開始直播」。直播期間可以隨時暫停、拖動進度或換片，朋友會看到一樣的畫面。
            </p>
          )}
        </Card>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      <aside className="grid content-start gap-4">
        {view.room?.inviteCode && (
          <InviteCodeCard
            inviteCode={view.room.inviteCode}
            onRegenerate={actions.regenerateInviteCode}
          />
        )}
        {view.room && (
          <StreamSettings
            room={view.room}
            viewers={viewers}
            onChange={(patch) => run(actions.updateRoom(patch))}
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
  const { view } = room;
  const host = view.members.find((m) => m.role === "host");
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="grid content-start gap-3">
        <div
          className="grid aspect-video place-items-center rounded-2xl bg-black text-center"
          data-testid="viewer-stage"
        >
          {view.stream.live ? (
            <p className="px-4 text-zinc-300">
              {host?.nickname ?? "房主"} 正在播放「{view.stream.title}」
              <span className="mt-1 block text-sm text-zinc-500">
                畫面連線功能開發中
              </span>
            </p>
          ) : (
            <p className="px-4 text-zinc-400">
              {host?.online
                ? `等待 ${host.nickname} 開始播放…`
                : "房主目前離線，等待房主回來…"}
            </p>
          )}
        </div>
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
            {closed.reload && (
              <Button onClick={() => location.reload()}>重新整理</Button>
            )}
            <Button
              variant={closed.reload ? "secondary" : "primary"}
              onClick={() => navigate("/")}
            >
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
      </div>
      {view.you?.role === "host" ? (
        <HostView room={room} />
      ) : view.you ? (
        <ViewerView room={room} />
      ) : null}
    </Layout>
  );
}
