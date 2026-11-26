import { useRef, useState } from "react";
import {
  ApiError,
  ERROR_MESSAGES,
  leaveRoom as apiLeaveRoom,
} from "../../lib/api";
import { navigate } from "../../lib/router";
import type { SignalClient } from "../../lib/signal";
import { liveIntent, roomToken } from "../../lib/storage";
import { withTabLock } from "../../lib/tab-lock";
import { comparedRooms } from "./compared-rooms";
import { forgetRoomIdentity } from "./room-state";

export type UseLeaveRoomOptions = {
  roomId: string;
  token: string | null;
  client: Pick<SignalClient, "stop"> | null;
  isLiveHost: boolean;
};

export type PerformLeaveRoomOptions = UseLeaveRoomOptions & {
  confirmLiveExit?: () => boolean;
  requestLeave?: (roomId: string, token: string) => Promise<void>;
  withLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  goHome?: () => void;
  setLeaving: (leaving: boolean) => void;
  setError: (error: string) => void;
};

/**
 * 明確退房流程（room-and-invite.md「主動離開房間」）：
 * 僅在伺服器回 204 或明確告知憑證／房間已不存在（401 UNAUTHORIZED／404 ROOM_NOT_FOUND）時，
 * 於同源鎖內條件清除身份並回首頁；網路錯誤、5xx 或回應遺失時留在原頁保留憑證供重試，並暫停 WS 4401 自動離房。
 */
export async function performLeaveRoom({
  roomId,
  token,
  client,
  isLiveHost,
  confirmLiveExit = () => window.confirm("目前正在直播中，確定要離開房間嗎？"),
  requestLeave = apiLeaveRoom,
  withLock = withTabLock,
  goHome = () => navigate("/"),
  setLeaving,
  setError,
}: PerformLeaveRoomOptions): Promise<boolean> {
  if (isLiveHost && !confirmLiveExit()) {
    return false;
  }
  if (!token) {
    liveIntent.set(roomId, false);
    goHome();
    return true;
  }
  setLeaving(true);
  setError("");
  try {
    await requestLeave(roomId, token);
  } catch (caught: unknown) {
    const confirmedGone =
      caught instanceof ApiError &&
      ((caught.status === 401 && caught.code === "UNAUTHORIZED") ||
        (caught.status === 404 && caught.code === "ROOM_NOT_FOUND"));
    if (!confirmedGone) {
      setError(
        caught instanceof ApiError ? caught.message : ERROR_MESSAGES.INTERNAL,
      );
      setLeaving(false);
      return false;
    }
  }
  // 收到 REST 結果後才取得與加入流程共用的同源鎖，避免刪除另一分頁剛寫入的新憑證與邀請對照。
  await withLock("room:join", async () => {
    liveIntent.set(roomId, false);
    forgetRoomIdentity(roomId, token);
    if (!roomToken.get(roomId)) comparedRooms.forget(roomId);
  });
  client?.stop();
  goHome();
  return true;
}

export function useLeaveRoom(options: UseLeaveRoomOptions) {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);

  async function leave() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const exited = await performLeaveRoom({
        ...options,
        setLeaving,
        setError,
      });
      if (!exited) busyRef.current = false;
    } catch (error) {
      busyRef.current = false;
      throw error;
    }
  }

  return {
    leaving,
    error,
    suppressAutoExit: leaving || Boolean(error),
    leave,
  };
}
