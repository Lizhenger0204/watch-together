import {
  JOIN_KEY_TTL_MS,
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
import { pendingJoinKey, roomInviteCode, roomToken } from "../../lib/storage";
import { withTabLock } from "../../lib/tab-lock";
import { comparedRooms } from "./compared-rooms";

export type { IdentityCheck };

const pendingChecks = new Map<string, Promise<IdentityCheck>>();

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
    if (roomToken.get(roomId) !== token) comparedRooms.forget(roomId);
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

/** 32 bytes 隨機值的 base64url（shared 的 joinKeySchema）。 */
function generateJoinKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * 這次加入的冪等鍵：沿用尚未確認結果的那把（回應遺失、或前一個分頁在保存身份前關閉），
 * 否則產生新的。送出前先存進共用儲存，在加入鎖內接手的分頁才讀得到。
 */
function joinKeyFor(inviteCode: string) {
  const pending = pendingJoinKey.get(inviteCode, JOIN_KEY_TTL_MS);
  if (pending) {
    return {
      key: pending,
      reusedPending: true,
      persisted: pendingJoinKey.persisted(inviteCode, pending),
    };
  }
  const key = generateJoinKey();
  const persisted = pendingJoinKey.set(inviteCode, key);
  return { key, reusedPending: false, persisted };
}

/**
 * 伺服器明確未配位時條件清除待完成鍵：
 * - 404 / 409 已在 RoomDO 查過重放紀錄，確定此鍵沒有對應的有效席位；
 * - 400 / 429 / 401 / 403 若發生在本次新產生的鍵，尚未進房就遭拒，也確定未配位；
 * - INTERNAL 或「既有待完成鍵重試遇到限流」結果未明，保留待完成鍵以便稍後重試。
 */
function shouldClearKeyOnError(error: unknown, reusedPending: boolean) {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "ROOM_NOT_FOUND" || error.code === "ROOM_FULL") {
    return true;
  }
  return !reusedPending && error.code !== "INTERNAL";
}

function clearKeyWhenSafe(
  inviteCode: string,
  roomId: string,
  key: string,
  keyPersisted: boolean,
) {
  // 身份已持久化，或這把鍵本來就沒寫進共用儲存（重新整理兩者都會消失）時清除；
  // 身份存不進去、但鍵已持久化時保留，讓重新整理或另一分頁仍可取回同一席。
  if (roomToken.persisted(roomId) || !keyPersisted) {
    pendingJoinKey.clearIfCurrent(inviteCode, key);
  }
}

async function joinNew(body: JoinRoomRequest, roomIds: string[]) {
  const pending = joinKeyFor(body.inviteCode);
  let joined;
  try {
    joined = roomIds.length
      ? joinRoomResponseSchema.parse(
          await conditionalJoin({
            ...body,
            excludeRoomIds: roomIds,
            joinKey: pending.key,
          }),
        )
      : await joinRoom(body.inviteCode, body.nickname, pending.key);
  } catch (error) {
    if (shouldClearKeyOnError(error, pending.reusedPending)) {
      pendingJoinKey.clearIfCurrent(body.inviteCode, pending.key);
    }
    throw error;
  }
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
      clearKeyWhenSafe(
        body.inviteCode,
        joined.roomId,
        pending.key,
        pending.persisted,
      );
      return { roomId: joined.roomId, reused: true };
    }
    break;
  }
  const tokenPersisted = roomToken.set(joined.roomId, joined.memberToken);
  roomInviteCode.set(joined.roomId, body.inviteCode);
  if (tokenPersisted || !pending.persisted) {
    pendingJoinKey.clearIfCurrent(body.inviteCode, pending.key);
  }
  return { roomId: joined.roomId, reused: false };
}

async function join(inviteCode: string, nickname: string) {
  pendingJoinKey.prune(JOIN_KEY_TTL_MS);
  const existingPending = pendingJoinKey.get(inviteCode, JOIN_KEY_TTL_MS);
  const existingPendingPersisted = existingPending
    ? pendingJoinKey.persisted(inviteCode, existingPending)
    : false;

  const known = roomInviteCode.findRoom(inviteCode);
  const token = known && roomToken.get(known);
  if (known && token) {
    const check = await verifyStoredIdentity(known, token);
    if (check === "valid") {
      if (existingPending) {
        clearKeyWhenSafe(
          inviteCode,
          known,
          existingPending,
          existingPendingPersisted,
        );
      }
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
  let identityExpired = false;
  const compared = comparedRooms.forCode(inviteCode, (id) => roomToken.get(id));
  for (const roomId of roomIds) {
    const existing = roomToken.get(roomId);
    if (!existing || compared.has(roomId, existing)) continue;
    try {
      const reused = reuseRoomResponseSchema.parse(
        await conditionalJoin({ ...body, existingRoomId: roomId }, existing),
      );
      if (reused.roomId !== roomId) throw new ApiError("INTERNAL");
      roomInviteCode.set(roomId, inviteCode);
      if (existingPending) {
        clearKeyWhenSafe(
          inviteCode,
          roomId,
          existingPending,
          existingPendingPersisted,
        );
      }
      return { roomId, reused: true };
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "ROOM_NOT_FOUND"))
        throw error;
      const check = await verifyStoredIdentity(roomId, existing);
      if (check === "unauthorized" || check === "room_closed")
        identityExpired = true;
      // 確認仍有效才記下：若中途達到 IP 限流，下次重試只比對尚未比對的房號。
      else if (check === "valid") compared.add(roomId, existing);
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
