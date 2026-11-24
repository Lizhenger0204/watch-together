import { useEffect, useRef, useState } from "react";
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
import {
  afterStreamCommandFailed,
  nextStreamCommand,
  type SentCommand,
} from "../features/room/live-intent";
import { roomExit, type RoomView } from "../features/room/room-state";
import { ApiError } from "../lib/api";
import { navigate } from "../lib/router";
import { SignalDisconnectedError, type ConnectionState } from "../lib/signal";
import { liveIntent, roomToken } from "../lib/storage";

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

/**
 * 房主的開播意圖：按「開始直播」成立、按「停止直播」才清除，存在這個分頁的 sessionStorage。
 * 重新驗證（伺服器把直播改成未開播）或換片檢查期間，依意圖與片源狀態自動補送 stream:status。
 */
function useLiveIntent(
  room: Room,
  roomId: string,
  ready: boolean,
  title: string,
) {
  const { view, actions } = room;
  const [intent, setIntentState] = useState(() => liveIntent.get(roomId));
  const [error, setError] = useState("");
  const lastSent = useRef<SentCommand | null>(null);
  const connected = view.connection.status === "open";
  const { session, stream } = view;

  useEffect(() => {
    const command = nextStreamCommand({
      intent,
      connected,
      session,
      stream,
      source: { ready, title },
      lastSent: lastSent.current,
    });
    if (!command) return;
    const sent = { session, command };
    lastSent.current = sent;
    setError("");
    actions.setStream(command.live, command.title)?.catch((e: unknown) => {
      // 較舊的請求失敗：之後已送出新的，不動紀錄、意圖，也不顯示錯誤。
      if (lastSent.current !== sent) return;
      const disconnected = e instanceof SignalDisconnectedError;
      const next = afterStreamCommandFailed(
        lastSent.current,
        sent,
        disconnected ? "disconnected" : "rejected",
      );
      lastSent.current = next.lastSent;
      if (next.cancelIntent) {
        liveIntent.set(roomId, false);
        setIntentState(false);
      }
      // 連線中斷由連線狀態提示，重新連線後會自動再送。
      if (!disconnected)
        setError(e instanceof ApiError ? e.message : "操作失敗，請稍後再試。");
    });
  }, [intent, connected, session, stream, ready, title, actions, roomId]);

  const setIntent = (on: boolean) => {
    liveIntent.set(roomId, on);
    setIntentState(on);
    setError("");
  };
  return { intent, setIntent, error };
}

function HostView({ room, roomId }: { room: Room; roomId: string }) {
  const { view, actions } = room;
  const source = useLocalSource();
  const { error, run } = useActionError();
  const { stream } = view;
  const ready = source.check.status === "ready";
  const online = view.connection.status === "open";
  const live = useLiveIntent(room, roomId, ready, source.title);
  const viewers = view.members.filter(
    (m) => m.role === "member" && m.online,
  ).length;
  const paused = live.intent && !stream.live;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid content-start gap-4">
        <Card
          title={
            stream.live
              ? `直播中：${stream.title ?? ""}`
              : paused
                ? "直播暫停中"
                : "選擇要播放的影片"
          }
          action={
            live.intent ? (
              <Button variant="danger" onClick={() => live.setIntent(false)}>
                停止直播
              </Button>
            ) : (
              <Button
                disabled={!ready || !online}
                onClick={() => live.setIntent(true)}
              >
                開始直播
              </Button>
            )
          }
        >
          {paused && (
            <div className="mb-3">
              <Notice tone="warning">
                {!online
                  ? "連線中斷，重新連上後會自動恢復直播。"
                  : source.check.status === "idle"
                    ? "重新整理後要重新選擇影片。選好並通過檢查後，會自動恢復直播。"
                    : "影片還不能播放（檢查中或需要確認）。可以播放後會自動恢復直播。"}
              </Notice>
            </div>
          )}
          <HostSourcePlayer source={source} />
          {!live.intent && (
            <p className="mt-3 text-sm text-zinc-500">
              選好影片並通過檢查後，按「開始直播」。直播期間可以隨時暫停、拖動進度或換片，朋友會看到一樣的畫面。
            </p>
          )}
        </Card>
        {live.error && <Notice tone="error">{live.error}</Notice>}
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

  // 房間關閉、被踢、身份失效：token 已經沒用，清掉並回首頁顯示原因。
  useEffect(() => {
    if (!exitNotice) return;
    roomToken.clear(roomId);
    navigate("/", { replace: true, notice: exitNotice });
  }, [exitNotice, roomId]);

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
      {view.you?.role === "host" ? (
        <HostView room={room} roomId={roomId} />
      ) : view.you ? (
        <ViewerView room={room} />
      ) : null}
    </Layout>
  );
}
