import { resolveQuality } from "@project/shared";
import { LogOut } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Layout } from "../components/Layout";
import { usePlayerDanmaku } from "../components/player";
import { Button, Notice } from "../components/ui";
import { ViewerPlayer } from "../features/player";
import { HostSourcePlayer, useLocalSource } from "../features/source";
import {
  ChatPanel,
  ENCODER_LAG_MESSAGE,
  InviteCodeCard,
  MemberList,
  QualityPanel,
  SidebarTabPanel,
  SidebarTabs,
  StreamSettings,
  qualityButtonLabel,
  useRoom,
  useUnreadChat,
} from "../features/room";
import type { HostPhase } from "../features/room/host-session-types";
import {
  forgetRoomIdentity,
  formatMbps,
  roomExit,
  uploadHint,
  type RoomView,
} from "../features/room/room-state";
import { useLeaveRoom } from "../features/room/use-leave-room";
import { ApiError } from "../lib/api";
import { navigate } from "../lib/router";
import type { ConnectionState } from "../lib/signal";
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

function hostTitle(
  phase: HostPhase,
  liveTitle: string | null,
  localTitle: string,
) {
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
      return localTitle || "選擇要播放的影片";
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
      bitrate: source.info?.bitrate ?? null,
    }),
  );
  const { error, run } = useActionError();
  /** 劇院模式：側欄移到影片下方，讓影片滿寬（只在桌面寬度有側欄時提供）。 */
  const [theater, setTheater] = useState(false);
  const [sideTab, setSideTab] = useState<"room" | "chat">("room");
  const youId = view.you?.memberId ?? "";
  const unreadChat = useUnreadChat(view.messages, sideTab === "chat");
  const { danmaku, danmakuOverlay } = usePlayerDanmaku(view.messages, youId);
  const { stream: sourceStream, title: sourceTitle, info: sourceInfo } = source;
  const sourceStatus = source.check.status;
  const sourceBitrate = sourceInfo?.bitrate ?? null;
  // 換檔、檢查狀態、片名或片源位元率改變（含第一次通過檢查）。
  useEffect(() => {
    host.setSource({
      stream: sourceStream,
      status: sourceStatus,
      title: sourceTitle,
      bitrate: sourceBitrate,
    });
  }, [host, sourceStream, sourceStatus, sourceTitle, sourceBitrate]);

  const ready = sourceStatus === "ready";
  const online = view.connection.status === "open";
  const onlineCount = view.members.filter((m) => m.online).length;
  const viewers = view.members.filter(
    (m) => m.role === "member" && m.online,
  ).length;
  const hostMember = view.members.find((m) => m.role === "host");
  const { phase } = session;
  const busy =
    phase === "starting" || phase === "stopping" || phase === "switching";
  const bitrate = view.room
    ? resolveQuality(view.room.quality, sourceBitrate).maxBitrate
    : 0;
  const upload = view.room
    ? uploadHint(view.room.mode, bitrate, viewers)
    : null;
  const showUploadWarn =
    (phase === "idle" || phase === "waiting") && Boolean(upload?.warn);
  const hasStageNotices =
    phase === "waiting" ||
    phase === "switching" ||
    showUploadWarn ||
    Boolean(session.error) ||
    Boolean(error);

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)] lg:min-h-[calc(100dvh-3rem)] ${
        theater ? "" : "lg:grid-cols-[minmax(0,1fr)_320px]"
      }`}
    >
      <div
        className={`flex min-w-0 flex-col ${theater ? "" : "lg:border-r lg:border-zinc-200"}`}
      >
        <HostSourcePlayer
          source={source}
          quality={
            view.room
              ? {
                  label: qualityButtonLabel(
                    view.room.quality,
                    sourceInfo?.height ?? null,
                  ),
                  disabled: busy || !online,
                  warning: session.encoderLagging
                    ? ENCODER_LAG_MESSAGE
                    : undefined,
                  panel: (
                    <QualityPanel
                      quality={view.room.quality}
                      pending={session.pendingQuality}
                      source={sourceInfo}
                      mode={view.room.mode}
                      viewers={viewers}
                      encoderLagging={session.encoderLagging}
                      onChange={(quality) => host.setQuality(quality)}
                    />
                  ),
                }
              : undefined
          }
          theater={{ on: theater, onToggle: () => setTheater(!theater) }}
          danmaku={danmaku}
          danmakuOverlay={danmakuOverlay}
          belowTitle={
            <h2 className="min-w-0 text-base font-semibold wrap-anywhere text-zinc-900">
              {hostTitle(phase, view.stream.title, sourceTitle)}
            </h2>
          }
          belowAction={
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
        />

        {hasStageNotices && (
          <div className="grid gap-2 px-4 py-3">
            {phase === "waiting" && (
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
            )}
            {phase === "switching" && (
              <Notice>正在切換傳送方式，收看者會短暫中斷。</Notice>
            )}
            {showUploadWarn && upload && (
              <Notice tone="warning">
                預估上傳 {formatMbps(upload.total)}，超過 60
                Mbps，建議調低位元率或改用「轉發」模式。
              </Notice>
            )}
            {session.error && (
              <Notice tone="error">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 wrap-anywhere">{session.error}</span>
                  <button
                    type="button"
                    className="shrink-0 text-red-700 underline-offset-2 hover:underline"
                    onClick={() => host.clearError()}
                  >
                    關閉
                  </button>
                </div>
              </Notice>
            )}
            {error && <Notice tone="error">{error}</Notice>}
          </div>
        )}
      </div>

      <aside
        className={`flex flex-col bg-white ${
          theater ? "" : "lg:sticky lg:top-0 lg:h-[calc(100dvh-3rem)]"
        }`}
      >
        <SidebarTabs
          idPrefix="host-side"
          label="房間側欄"
          active={sideTab}
          onChange={setSideTab}
          tabs={[
            { id: "room", label: "房間" },
            { id: "chat", label: "聊天", badge: unreadChat },
          ]}
        />
        <SidebarTabPanel
          idPrefix="host-side"
          id="room"
          active={sideTab === "room"}
        >
          <div
            className={`flex min-h-0 flex-1 flex-col divide-y divide-zinc-200 overflow-y-auto ${
              theater ? "lg:grid lg:grid-cols-3 lg:divide-x lg:divide-y-0" : ""
            }`}
          >
            {view.room?.inviteCode && (
              <InviteCodeCard
                inviteCode={view.room.inviteCode}
                inviteCodeVersion={view.room.inviteCodeVersion ?? 0}
                hostName={hostMember?.nickname ?? "房主"}
                onlineCount={onlineCount}
                onRegenerate={actions.regenerateInviteCode}
              />
            )}
            <MemberList
              members={view.members}
              youId={youId}
              isHost
              memberStatus={view.memberStatus}
              onKick={(memberId) => run(actions.kick(memberId))}
            />
            {view.room && (
              <StreamSettings
                room={view.room}
                viewers={viewers}
                bitrate={bitrate}
                busy={busy || !online}
                onModeChange={(mode) => host.setMode(mode)}
                onLockedChange={(locked) => run(actions.updateRoom({ locked }))}
              />
            )}
          </div>
        </SidebarTabPanel>
        <SidebarTabPanel
          idPrefix="host-side"
          id="chat"
          active={sideTab === "chat"}
        >
          <ChatPanel
            messages={view.messages}
            youId={youId}
            connected={online}
            onSend={actions.sendChat}
            visible={sideTab === "chat"}
            className={theater ? "h-80 lg:flex-1" : "h-80 lg:h-auto lg:flex-1"}
          />
        </SidebarTabPanel>
      </aside>
    </div>
  );
}

function ViewerView({ room }: { room: Room }) {
  const { view, viewer, actions } = room;
  const host = view.members.find((m) => m.role === "host");
  const onlineCount = view.members.filter((m) => m.online).length;
  const online = view.connection.status === "open";
  const youId = view.you?.memberId ?? "";
  const [chatOpen, setChatOpen] = useState(true);
  const [sideTab, setSideTab] = useState<"chat" | "members">("chat");
  const unreadChat = useUnreadChat(
    view.messages,
    chatOpen && sideTab === "chat",
  );
  const { danmaku, danmakuOverlay } = usePlayerDanmaku(view.messages, youId);
  const openChat = () => {
    setChatOpen(true);
    setSideTab("chat");
  };

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)] lg:min-h-[calc(100dvh-3rem)] ${
        chatOpen ? "lg:grid-cols-[minmax(0,1fr)_320px]" : ""
      }`}
    >
      <section
        className={`flex min-w-0 flex-col ${chatOpen ? "lg:border-r lg:border-zinc-200" : ""}`}
      >
        {viewer && (
          <ViewerPlayer
            viewer={viewer}
            hostName={host?.nickname ?? null}
            hostOnline={host?.online ?? false}
            hostPresent={Boolean(host)}
            danmaku={danmaku}
            danmakuOverlay={danmakuOverlay}
            chat={{
              open: chatOpen,
              onToggle: () => (chatOpen ? setChatOpen(false) : openChat()),
              onOpen: openChat,
            }}
          />
        )}
        {/* 片名顯示在影片正下方（對齊 DESIGN.md §3） */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
          {view.stream.live && view.stream.title ? (
            <>
              <h2 className="min-w-0 flex-1 text-base font-semibold wrap-anywhere text-zinc-900">
                {view.stream.title}
              </h2>
              <span className="shrink-0 text-xs font-medium text-[#0072b2]">
                直播中
              </span>
            </>
          ) : (
            <p className="text-sm text-zinc-500">尚未開始播放</p>
          )}
        </div>
      </section>

      {chatOpen && (
        <aside className="flex flex-col bg-white lg:sticky lg:top-0 lg:h-[calc(100dvh-3rem)]">
          <div className="shrink-0 border-b border-zinc-200 px-4 py-3">
            {host ? (
              <p className="truncate text-sm text-zinc-900">
                <span className="font-semibold text-[#0072b2]">
                  {host.nickname}
                </span>{" "}
                正在主持
              </p>
            ) : (
              <p className="truncate text-sm font-medium text-zinc-700">
                房主已離開房間
              </p>
            )}
            <p className="text-xs text-zinc-500">{onlineCount} 人在線</p>
          </div>
          <SidebarTabs
            idPrefix="viewer-side"
            label="聊天側欄"
            active={sideTab}
            onChange={setSideTab}
            tabs={[
              { id: "chat", label: "聊天", badge: unreadChat },
              { id: "members", label: `成員（${onlineCount}）` },
            ]}
          />
          <SidebarTabPanel
            idPrefix="viewer-side"
            id="chat"
            active={sideTab === "chat"}
          >
            <ChatPanel
              messages={view.messages}
              youId={youId}
              connected={online}
              onSend={actions.sendChat}
              visible={sideTab === "chat"}
              className="h-80 lg:h-auto lg:flex-1"
            />
          </SidebarTabPanel>
          <SidebarTabPanel
            idPrefix="viewer-side"
            id="members"
            active={sideTab === "members"}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <MemberList
                members={view.members}
                youId={youId}
                isHost={false}
                memberStatus={{}}
                onKick={() => {}}
              />
            </div>
          </SidebarTabPanel>
        </aside>
      )}
    </div>
  );
}

export function RoomPage({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const { view } = room;
  const leave = useLeaveRoom({
    roomId,
    token: room.token,
    client: room.client,
    isLiveHost: view.you?.role === "host" && view.stream.live,
  });
  const exit = room.corrupted
    ? { notice: "本機儲存的身份資料損壞了，請重新用邀請碼加入。" }
    : leave.suppressAutoExit
      ? null
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
        <div className="mx-auto max-w-sm border-t border-zinc-200 pt-6">
          <h1 className="mb-2 text-xl font-bold text-zinc-900">
            你還沒加入這個房間
          </h1>
          <p className="mb-6 text-sm text-zinc-500">
            請向房主索取邀請碼或邀請連結。
          </p>
          <Button onClick={() => navigate("/")}>回首頁輸入邀請碼</Button>
        </div>
      </Layout>
    );
  }

  const closed = closedMessage(view);
  if (closed) {
    const leaveClosed = () => {
      liveIntent.set(roomId, false);
      navigate("/");
    };
    return (
      <Layout onBrandClick={leaveClosed}>
        <div className="mx-auto max-w-sm border-t border-zinc-200 pt-6">
          <h1 className="mb-2 text-xl font-bold text-zinc-900">
            {closed.title}
          </h1>
          <p className="mb-6 text-sm text-zinc-500">{closed.detail}</p>
          <div className="flex gap-2">
            <Button onClick={() => location.reload()}>重新整理</Button>
            <Button variant="secondary" onClick={leaveClosed}>
              回首頁
            </Button>
          </div>
        </div>
      </Layout>
    );
  }

  const showTopNotices =
    view.connection.status === "connecting" ||
    view.connection.status === "reconnecting" ||
    Boolean(leave.error) ||
    Boolean(view.lastError) ||
    !roomToken.persisted(roomId);

  return (
    <Layout
      flush
      onBrandClick={() => void leave.leave()}
      headerRight={
        <Button
          variant="ghost"
          className="min-h-8 px-2.5 text-xs"
          disabled={leave.leaving}
          onClick={() => void leave.leave()}
        >
          <LogOut className="size-3.5" strokeWidth={1.75} />
          離開房間
        </Button>
      }
    >
      {showTopNotices && (
        <div className="grid gap-2 border-b border-zinc-200 bg-white px-4 py-2">
          <ConnectionNotice connection={view.connection} />
          {leave.error && <Notice tone="error">{leave.error}</Notice>}
          {view.lastError && <Notice tone="error">{view.lastError}</Notice>}
          {!roomToken.persisted(roomId) && (
            <Notice tone="warning">
              瀏覽器不允許儲存資料，重新整理或關閉分頁後會失去在這個房間的身份。
            </Notice>
          )}
        </div>
      )}
      {view.you?.role === "host" && room.host ? (
        <HostView room={room} host={room.host} />
      ) : view.you ? (
        <ViewerView room={room} />
      ) : null}
    </Layout>
  );
}
