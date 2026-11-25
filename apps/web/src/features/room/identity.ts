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
import { withTabLock } from "../../lib/tab-lock";

export type { IdentityCheck };

const pendingChecks = new Map<string, Promise<IdentityCheck>>();
/**
 * 邀請碼 → 已確認「不是這個碼的房間」的身份（房號＋憑證）。遇到加入限流時，
 * 下一個時窗從尚未比對的房號接著比，全部比完就直接回傳原本的滿房或超限提示。
 * 只存在分頁記憶體；邀請碼對應的房間不會改變，憑證換了就重新比對。
 */
const comparedRooms = new Map<string, Set<string>>();
const comparedKey = (roomId: string, token: string) => `${roomId}\0${token}`;

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

/** 持有憑證的房號（共用儲存與本分頁記憶體，例如存不進去的房主憑證）。 */
function roomsWithTokens() {
  return roomToken
    .rooms()
    .filter(
      (id) => joinRoomRequestSchema.shape.existingRoomId.safeParse(id).success,
    );
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
    if (check === "valid") return { roomId: known, reused: true };
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
  let identityExpired = false;
  const compared = comparedRooms.get(inviteCode) ?? new Set<string>();
  comparedRooms.set(inviteCode, compared);
  for (const roomId of roomIds) {
    const existing = roomToken.get(roomId);
    if (!existing || compared.has(comparedKey(roomId, existing))) continue;
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
      const check = await verifyStoredIdentity(roomId, existing);
      if (check === "unauthorized" || check === "room_closed")
        identityExpired = true;
      // 確認仍有效才記下：若中途達到 IP 限流，下次重試只比對尚未比對的房號。
      else if (check === "valid") compared.add(comparedKey(roomId, existing));
    }
  }
  if (identityExpired && admissionError?.code === "ROOM_NOT_FOUND") {
    // 舊身份剛確認失效並已清除：同一個邀請碼再送一次就能重新加入，不要讓人以為碼打錯。
    const expired = new ApiError("ROOM_NOT_FOUND");
    expired.message = "先前保存的房間身份已失效，請再按一次「加入」。";
    throw expired;
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
  // 跨分頁依序：沒有 Web Locks 時以 IndexedDB 租約協調（lib/tab-lock.ts）。
  // 進入後 join() 才讀身份，因此會看到前一個分頁剛存好的憑證。
  const result = withTabLock("room:join", () =>
    join(inviteCode, nickname),
  ).finally(() => pendingJoins.delete(inviteCode));
  pendingJoins.set(inviteCode, result);
  return result;
}

/** 測試用：清空分頁記憶體中已比對過的房間。 */
export function resetComparedRooms() {
  comparedRooms.clear();
}
