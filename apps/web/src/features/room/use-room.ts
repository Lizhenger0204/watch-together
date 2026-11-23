import type { Mode, Quality } from "@project/shared";
import { useEffect, useMemo, useReducer, useState } from "react";
import { regenerateInviteCode } from "../../lib/api";
import { SignalClient, signalUrl } from "../../lib/signal";
import { roomToken } from "../../lib/storage";
import { initialRoomView, roomReducer } from "./room-state";

/** 進入房間：用 localStorage 裡的 token 連 WebSocket，提供房間狀態與操作。 */
export function useRoom(roomId: string) {
  const [token] = useState(() => roomToken.get(roomId));
  const [view, dispatch] = useReducer(roomReducer, initialRoomView);

  const client = useMemo(
    () => (token ? new SignalClient({ url: signalUrl(roomId), token }) : null),
    [roomId, token],
  );

  useEffect(() => {
    if (!client) return;
    const offMessage = client.onMessage((message) =>
      dispatch({ kind: "message", message }),
    );
    const offState = client.onState((state) => {
      dispatch({ kind: "connection", state });
      // 被踢或 token 無效：token 已經沒用了，清掉。
      if (
        state.status === "closed" &&
        (state.reason === "kicked" || state.reason === "unauthorized")
      ) {
        roomToken.clear(roomId);
      }
    });
    client.start();
    return () => {
      offMessage();
      offState();
      client.stop();
    };
  }, [client, roomId]);

  const actions = useMemo(
    () => ({
      updateRoom: (patch: {
        mode?: Mode;
        quality?: Quality;
        locked?: boolean;
      }) => client?.request({ type: "room:update", ...patch }),
      kick: (memberId: string) =>
        client?.request({ type: "room:kick", memberId }),
      setStream: (live: boolean, title: string | null) =>
        client?.request({ type: "stream:status", live, title }),
      regenerateInviteCode: () =>
        token ? regenerateInviteCode(roomId, token) : Promise.reject(),
      clearError: () => dispatch({ kind: "clear-error" }),
    }),
    [client, roomId, token],
  );

  return { hasToken: token !== null, token, view, actions, client };
}
