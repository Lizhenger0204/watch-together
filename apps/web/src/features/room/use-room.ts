import { tokenSchema } from "@project/shared";
import { useEffect, useMemo, useReducer, useState } from "react";
import { regenerateInviteCode } from "../../lib/api";
import { SignalClient, signalUrl } from "../../lib/signal";
import { roomInviteCode, roomToken } from "../../lib/storage";
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

  useEffect(() => {
    if (!client) return;
    const offMessage = client.onMessage((message) =>
      dispatch({ kind: "message", message }),
    );
    const offState = client.onState((state) =>
      dispatch({ kind: "connection", state }),
    );
    // 在 start() 前掛上，才能緩衝驗證後馬上到的信令。
    const detachViewer = viewer?.attach();
    client.start();
    return () => {
      offMessage();
      offState();
      detachViewer?.();
      client.stop();
    };
  }, [client, viewer]);

  // 記住房主看到的邀請碼，房主開自己的邀請連結時才認得出是這一房。
  const inviteCode = view.you?.role === "host" ? view.room?.inviteCode : null;
  useEffect(() => {
    if (inviteCode) roomInviteCode.set(roomId, inviteCode);
  }, [roomId, inviteCode]);

  const actions = useMemo(
    () => ({
      updateRoom: (patch: RoomUpdate) =>
        client?.request({ type: "room:update", ...patch }),
      kick: (memberId: string) =>
        client?.request({ type: "room:kick", memberId }),
      setStream: (live: boolean, title: string | null) =>
        client?.request({ type: "stream:status", live, title }),
      async regenerateInviteCode() {
        if (!token) throw new Error("no token");
        const result = await regenerateInviteCode(roomId, token);
        // WebSocket 斷線時收不到 room:updated，直接用 REST 回應更新。
        dispatch({ kind: "invite-code", inviteCode: result.inviteCode });
        return result;
      },
      clearError: () => dispatch({ kind: "clear-error" }),
    }),
    [client, roomId, token],
  );

  return { hasToken: token !== null, corrupted, view, actions, client, viewer };
}
