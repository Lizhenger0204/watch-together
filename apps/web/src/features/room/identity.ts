import {
  errorResponseSchema,
  iceResponseSchema,
  joinRoomRequestSchema,
  joinRoomResponseSchema,
  reuseRoomResponseSchema,
  type JoinRoomRequest,
} from "@project/shared";
import { ApiError, joinRoom } from "../../lib/api";
import type { IdentityCheck } from "../../lib/signal";
import { roomInviteCode, roomToken } from "../../lib/storage";

export type { IdentityCheck };

const pendingChecks = new Map<string, Promise<IdentityCheck>>();
// 僅記房號。即使瀏覽器封鎖 localStorage，本分頁也能為曾加入的房間比對新邀請碼。
const rememberedRooms = new Set<string>();

async function fetchIdentityIce(roomId: string, token: string) {
  const response = await fetch(`/api/rooms/${roomId}/ice`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (response.status === 401) throw new ApiError("UNAUTHORIZED");
  if (response.status === 404) throw new ApiError("ROOM_NOT_FOUND");
  if (!response.ok) throw new ApiError("INTERNAL");
  return iceResponseSchema.parse(await response.json());
}

export function checkIdentity(
  roomId: string,
  token: string,
  getIce = fetchIdentityIce,
): Promise<IdentityCheck> {
  const key = `${roomId}\0${token}`;
  const pending = pendingChecks.get(key);
  if (pending) return pending;
  const check = getIce(roomId, token)
    .then((): IdentityCheck => "valid")
    .catch((error: unknown): IdentityCheck => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED")
        return "unauthorized";
      if (error instanceof ApiError && error.code === "ROOM_NOT_FOUND")
        return "room_closed";
      return "unknown";
    })
    .finally(() => pendingChecks.delete(key));
  pendingChecks.set(key, check);
  return check;
}

function roomsWithTokens() {
  try {
    const store = globalThis.localStorage;
    for (let i = 0; store && i < store.length; i++) {
      const roomId = /^room:(.+):token$/.exec(store.key(i) ?? "")?.[1];
      if (
        roomId &&
        joinRoomRequestSchema.shape.existingRoomId.safeParse(roomId).success
      ) {
        rememberedRooms.add(roomId);
      }
    }
  } catch {
    // 瀏覽器可能禁止讀取 localStorage，仍使用分頁記憶體中的房號。
  }
  for (const id of rememberedRooms) {
    if (!roomToken.get(id)) rememberedRooms.delete(id);
  }
  return [...rememberedRooms];
}

function forgetInvalid(roomId: string, token: string) {
  if (roomToken.get(roomId) !== token) return;
  try {
    const shared = globalThis.localStorage?.getItem(`room:${roomId}:token`);
    if (shared && shared !== token) {
      // 本分頁的快取已失效，改用另一分頁剛寫入的憑證。
      roomToken.set(roomId, shared);
      return;
    }
  } catch {
    // 只存在本分頁的身份同樣可以失效。
  }
  roomToken.clear(roomId);
}

async function conditionalJoin(body: JoinRoomRequest, token?: string) {
  const response = await fetch("/api/rooms/join", {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new ApiError("INTERNAL");
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(json);
    throw new ApiError(
      response.status >= 500 || !error.success
        ? "INTERNAL"
        : error.data.error.code,
    );
  }
  return json;
}

async function join(
  inviteCode: string,
  nickname: string,
): Promise<{ roomId: string; reused: boolean }> {
  const known = roomInviteCode.findRoom(inviteCode);
  const token = known && roomToken.get(known);
  if (known && token) {
    const check = await checkIdentity(known, token);
    if (check === "valid") {
      rememberedRooms.add(known);
      return { roomId: known, reused: true };
    }
    if (check === "unknown") throw new ApiError("INTERNAL");
    forgetInvalid(known, token);
    throw new ApiError(
      check === "unauthorized" ? "UNAUTHORIZED" : "ROOM_NOT_FOUND",
    );
  }

  const roomIds = roomsWithTokens();
  const body = { inviteCode, nickname };
  try {
    const joined = roomIds.length
      ? joinRoomResponseSchema.parse(
          await conditionalJoin({ ...body, excludeRoomIds: roomIds }),
        )
      : await joinRoom(inviteCode, nickname);
    rememberedRooms.add(joined.roomId);
    // 新身份可能在請求途中由另一分頁寫入。先保住房主或既有成員的憑證。
    const current = roomToken.get(joined.roomId);
    if (current && current !== joined.memberToken) {
      const check = await checkIdentity(joined.roomId, current);
      if (check === "unknown") throw new ApiError("INTERNAL");
      if (check === "valid") {
        roomInviteCode.set(joined.roomId, inviteCode);
        return { roomId: joined.roomId, reused: true };
      }
    }
    roomToken.set(joined.roomId, joined.memberToken);
    roomInviteCode.set(joined.roomId, inviteCode);
    return { roomId: joined.roomId, reused: false };
  } catch (error) {
    if (
      !(error instanceof ApiError && error.code === "ROOM_NOT_FOUND") ||
      !roomIds.length
    )
      throw error;
  }

  // 404 同時涵蓋已排除的席位、鎖房與錯碼。只能拿舊憑證逐房驗證。
  for (const roomId of roomIds) {
    const existing = roomToken.get(roomId);
    if (!existing) continue;
    try {
      const reused = reuseRoomResponseSchema.parse(
        await conditionalJoin({ ...body, existingRoomId: roomId }, existing),
      );
      if (reused.roomId !== roomId) throw new ApiError("INTERNAL");
      roomInviteCode.set(roomId, inviteCode);
      return { roomId, reused: true };
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "ROOM_NOT_FOUND"))
        throw error;
      // 若中途達到 IP 限流，下次重試會先檢查尚未比對的房號。
      rememberedRooms.delete(roomId);
      rememberedRooms.add(roomId);
    }
  }
  throw new ApiError("ROOM_NOT_FOUND");
}

const pendingJoins = new Map<string, ReturnType<typeof join>>();

/** 同源分頁同時首次提交邀請碼，也要等前一筆存好身份再決定是否配置。 */
export function joinKeepingIdentity(inviteCode: string, nickname: string) {
  const pending = pendingJoins.get(inviteCode);
  if (pending) return pending;
  const enter = () => join(inviteCode, nickname);
  const next = globalThis.navigator?.locks
    ? navigator.locks.request("room:join", enter)
    : enter();
  const result = next.finally(() => pendingJoins.delete(inviteCode));
  pendingJoins.set(inviteCode, result);
  return result;
}
