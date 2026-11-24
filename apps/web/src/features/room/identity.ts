import { ApiError, getIceServers, joinRoom } from "../../lib/api";
import type { IdentityCheck } from "../../lib/signal";
import { roomInviteCode, roomToken } from "../../lib/storage";

export type { IdentityCheck };

/** 用 REST 確認本機的 token 還能不能用（protocol.md：GET /ice 需要成員身份）。 */
export async function checkIdentity(
  roomId: string,
  token: string,
  getIce: typeof getIceServers = getIceServers,
): Promise<IdentityCheck> {
  try {
    await getIce(roomId, token);
    return "valid";
  } catch (error) {
    if (!(error instanceof ApiError)) return "unknown";
    if (error.code === "UNAUTHORIZED") return "unauthorized";
    if (error.code === "ROOM_NOT_FOUND") return "room_closed";
    return "unknown";
  }
}

type JoinDeps = {
  join: typeof joinRoom;
  check: (roomId: string, token: string) => Promise<IdentityCheck>;
};

/**
 * 用邀請碼加入，但不覆寫同一房已經有效的身份（例如房主開了自己的邀請連結）。
 * 只有確認舊 token 已失效，才換成新拿到的 token。
 * 加入成功後記住邀請碼與房間的對照：之後再點同一個邀請連結就直接回房，
 * 不再 `POST /join`（否則每點一次就在伺服器多一個離線成員，很快 `ROOM_FULL`）。
 */
export async function joinKeepingIdentity(
  inviteCode: string,
  nickname: string,
  deps: JoinDeps = { join: joinRoom, check: checkIdentity },
): Promise<{ roomId: string; reused: boolean }> {
  const known = roomInviteCode.findRoom(inviteCode);
  const knownToken = known && roomToken.get(known);
  if (known && knownToken) {
    if ((await deps.check(known, knownToken)) === "valid") {
      return { roomId: known, reused: true };
    }
  }

  const joined = await deps.join(inviteCode, nickname);
  roomInviteCode.set(joined.roomId, inviteCode);
  const existing = roomToken.get(joined.roomId);
  if (existing && existing !== joined.memberToken) {
    const result = await deps.check(joined.roomId, existing);
    // 無法確認（網路錯誤）時寧可保留舊身份：房主身份覆寫後就救不回來。
    if (result === "valid" || result === "unknown") {
      return { roomId: joined.roomId, reused: true };
    }
  }
  roomToken.set(joined.roomId, joined.memberToken);
  return { roomId: joined.roomId, reused: false };
}
