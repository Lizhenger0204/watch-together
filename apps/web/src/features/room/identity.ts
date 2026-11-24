import {
  JOIN_MAX_EXCLUDED_ROOMS,
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

async function verifyStoredIdentity(roomId: string, token: string) {
  const check = await checkIdentity(roomId, token);
  if (check === "unauthorized" || check === "room_closed") {
    roomToken.clearIfCurrent(roomId, token);
  }
  return check;
}

async function roomsToExclude() {
  const ids = roomsWithTokens();
  if (ids.length <= JOIN_MAX_EXCLUDED_ROOMS) return ids;
  let remaining = ids.length;
  for (const id of ids) {
    const token = roomToken.get(id);
    if (token) await verifyStoredIdentity(id, token);
    if (!roomToken.get(id)) remaining--;
    if (remaining <= JOIN_MAX_EXCLUDED_ROOMS) break;
  }
  return roomsWithTokens();
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

async function joinNew(body: JoinRoomRequest, roomIds: string[]) {
  const joined = roomIds.length
    ? joinRoomResponseSchema.parse(
        await conditionalJoin({ ...body, excludeRoomIds: roomIds }),
      )
    : await joinRoom(body.inviteCode, body.nickname);
  rememberedRooms.add(joined.roomId);
  // 新身份可能在請求途中由另一分頁寫入。先保住房主或既有成員的憑證。
  let current = roomToken.get(joined.roomId);
  while (current && current !== joined.memberToken) {
    const check = await checkIdentity(joined.roomId, current);
    const latest = roomToken.get(joined.roomId);
    if (current !== latest) {
      current = latest;
      continue;
    }
    if (check === "unknown") throw new ApiError("INTERNAL");
    if (check === "valid") {
      roomInviteCode.set(joined.roomId, body.inviteCode);
      return { roomId: joined.roomId, reused: true };
    }
    break;
  }
  roomToken.set(joined.roomId, joined.memberToken);
  roomInviteCode.set(joined.roomId, body.inviteCode);
  return { roomId: joined.roomId, reused: false };
}

async function join(inviteCode: string, nickname: string) {
  const known = roomInviteCode.findRoom(inviteCode);
  const token = known && roomToken.get(known);
  if (known && token) {
    const check = await verifyStoredIdentity(known, token);
    if (check === "valid") {
      rememberedRooms.add(known);
      return { roomId: known, reused: true };
    }
    if (check === "unknown") throw new ApiError("INTERNAL");
    throw new ApiError(
      check === "unauthorized" ? "UNAUTHORIZED" : "ROOM_NOT_FOUND",
    );
  }

  const roomIds = await roomsToExclude();
  const body = { inviteCode, nickname };
  let admissionError: ApiError | undefined;
  if (roomIds.length <= JOIN_MAX_EXCLUDED_ROOMS) {
    try {
      return await joinNew(body, roomIds);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        (error.code !== "ROOM_NOT_FOUND" && error.code !== "ROOM_FULL")
      )
        throw error;
      admissionError = error;
    }
  }

  // 鎖房、滿房或名單超過上限時，已有的席位仍可沿用。
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
      await verifyStoredIdentity(roomId, existing);
      // 若中途達到 IP 限流，下次重試會先檢查尚未比對的房號。
      rememberedRooms.delete(roomId);
      rememberedRooms.add(roomId);
    }
  }
  if (admissionError) throw admissionError;
  const error = new ApiError("BAD_REQUEST");
  error.message = `這個瀏覽器保存的房間身份超過 ${JOIN_MAX_EXCLUDED_ROOMS} 個，請等舊房間到期後再加入新房。`;
  throw error;
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
