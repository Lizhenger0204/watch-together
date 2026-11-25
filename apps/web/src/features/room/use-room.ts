import { tokenSchema } from "@project/shared";
import { useEffect, useMemo, useReducer, useState } from "react";
import { regenerateInviteCode } from "../../lib/api";
import { SignalClient, signalUrl } from "../../lib/signal";
import { liveIntent, roomInviteCode, roomToken } from "../../lib/storage";
import { HostSession } from "./host-session";
import { checkIdentity } from "./identity";
import { initialRoomView, roomReducer, type RoomUpdate } from "./room-state";
import { ViewerSession } from "./viewer-session";

/** 本機的 token 格式壞掉（例如被截短）：連了也只會被 4400 拒絕，當成沒有身份（由頁面清掉）。 */
function loadToken(roomId: string) {
  const token = roomToken.get(roomId);
  if (token === null) return { token: null, corrupted: false };
  if (tokenSchema.safeParse(token).success) return { token, corrupted: false };
  return { token: null, corrupted: true };
}

/** 進入房間：用本機的 token 連 WebSocket，提供房間狀態與操作。 */
export function useRoom(roomId: string) {
  const [{ token, corrupted }] = useState(() => loadToken(roomId));
  const [view, dispatch] = useReducer(roomReducer, initialRoomView);
  // 收看者手動重連（P2P）要換一條新的 WebSocket 重新驗證（streaming.md §3）。
  const [socketGeneration, setSocketGeneration] = useState(0);

  const client = useMemo(
    () =>
      token
        ? new SignalClient({
            url: signalUrl(roomId),
            token,
            verifyIdentity: () => checkIdentity(roomId, token),
          })
        : null,
    // socketGeneration 變了就建立新的 SignalClient（新的 WebSocket）。
    [roomId, token, socketGeneration],
  );

  // 收看者的房間層：和 SignalClient 同生同滅，房主端不做任何事。
  const viewer = useMemo(
    () =>
      client && token
        ? new ViewerSession({
            client,
            roomId,
            token,
            requestNewSocket: () => setSocketGeneration((g) => g + 1),
          })
        : null,
    [client, roomId, token],
  );

  // 房主的房間層：和 SignalClient 同生同滅，收看者端不做任何事。
  // 房主的 stream:status（開播、停播、重新驗證後恢復）一律由它送出。
  const host = useMemo(
    () =>
      client && token
        ? new HostSession({
            client,
            roomId,
            token,
            initialIntent: liveIntent.get(roomId),
            onIntentChange: (on) => liveIntent.set(roomId, on),
            onExplicitStop: () => liveIntent.stopEverywhere(roomId),
            intentStillValid: () => liveIntent.get(roomId),
          })
        : null,
    [client, roomId, token],
  );

  useEffect(() => {
    if (!client) return;
    const offMessage = client.onMessage((message) => {
      if (
        (message.type === "room:snapshot" || message.type === "room:updated") &&
        message.room.inviteCode !== undefined
      ) {
        const latest = roomInviteCode.sync(
          roomId,
          message.room.inviteCode,
          message.room.inviteCodeVersion ?? 0,
        );
        dispatch({
          kind: "message",
          message: {
            ...message,
            room: {
              ...message.room,
              inviteCode: latest.inviteCode,
              inviteCodeVersion: latest.version,
            },
          },
        });
        return;
      }
      dispatch({ kind: "message", message });
    });
    const offState = client.onState((state) =>
      dispatch({ kind: "connection", state }),
    );
    const offInvite = roomInviteCode.subscribe(roomId, (latest) =>
      dispatch({
        kind: "invite-code",
        inviteCode: latest.inviteCode,
        inviteCodeVersion: latest.version,
      }),
    );
    // 在 start() 前掛上，才能緩衝驗證後馬上到的信令。
    const detachViewer = viewer?.attach();
    const detachHost = host?.attach();
    client.start();
    return () => {
      offMessage();
      offState();
      offInvite();
      detachViewer?.();
      detachHost?.();
      client.stop();
    };
  }, [client, viewer, host, roomId]);

  // 記住房主看到的最新邀請碼與版本，房主開自己的邀請連結或跨分頁換碼時不會被舊碼倒退覆蓋。
  const inviteCode = view.you?.role === "host" ? view.room?.inviteCode : null;
  const inviteCodeVersion =
    view.you?.role === "host" ? (view.room?.inviteCodeVersion ?? 0) : null;
  useEffect(() => {
    if (inviteCode && inviteCodeVersion !== null) {
      roomInviteCode.sync(roomId, inviteCode, inviteCodeVersion);
    }
  }, [roomId, inviteCode, inviteCodeVersion]);

  const actions = useMemo(
    () => ({
      updateRoom: (patch: RoomUpdate) =>
        client?.request({ type: "room:update", ...patch }),
      kick: (memberId: string) =>
        client?.request({ type: "room:kick", memberId }),
      sendChat: (text: string) => client?.request({ type: "chat:send", text }),
      async regenerateInviteCode() {
        if (!token) throw new Error("no token");
        const result = await regenerateInviteCode(roomId, token);
        // 先和同源共用儲存核對版本：斷線期間另一分頁可能已換到更新的碼，
        // 一律採用版本較高的有效碼，絕不把共用對照與畫面蓋回失效舊碼。
        const latest = roomInviteCode.sync(
          roomId,
          result.inviteCode,
          result.inviteCodeVersion,
        );
        dispatch({
          kind: "invite-code",
          inviteCode: latest.inviteCode,
          inviteCodeVersion: latest.version,
        });
        return {
          inviteCode: latest.inviteCode,
          inviteCodeVersion: latest.version,
        };
      },
      clearError: () => dispatch({ kind: "clear-error" }),
    }),
    [client, roomId, token],
  );

  return {
    /** 這個分頁連線用的憑證（機密，不可寫進 log、URL 或畫面）。 */
    token,
    hasToken: token !== null,
    corrupted,
    view,
    actions,
    client,
    viewer,
    host,
  };
}
