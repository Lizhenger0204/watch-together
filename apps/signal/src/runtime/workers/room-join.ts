import type { ReuseRoomResponse } from "@project/shared";
import type { RoomConfig } from "../../config";
import type { Result } from "../../errors";
import { generateId, generateToken, hashToken } from "../../room/crypto";
import {
  admitMember,
  deriveJoinKey,
  openJoinToken,
  sealJoinToken,
} from "../../room/join-key";
import {
  findMemberByTokenHash,
  type Online,
  type RoomState,
} from "../../room/room";
import type { SerialQueue } from "./serial-queue";

// RoomDO 的加入與沿用。配位在 changes 佇列內查表、寫表（T-129）：
// 佇列內只做純計算與本機交易，雜湊、導出金鑰、加解密都在佇列外。

export type JoinInput = {
  inviteCode: string;
  nickname: string;
  excluded?: boolean;
  /** protocol.md「加入冪等」。機密，不可寫進 log。 */
  joinKey?: string;
};

export type JoinDeps = {
  room(): RoomState | null;
  changes: SerialQueue;
  online(): Online;
  save(next: RoomState): Promise<void>;
  config: RoomConfig;
};

export async function joinMember(
  deps: JoinDeps,
  input: JoinInput,
): Promise<Result<{ memberToken: string; memberId: string }>> {
  const memberToken = generateToken();
  const memberId = generateId();
  const tokenHash = await hashToken(memberToken);
  // roomId 就是 DO 名稱，不會變；房間不存在時佇列內一樣回 404。
  const roomId = deps.room()?.roomId;
  const derived =
    input.joinKey && roomId ? await deriveJoinKey(input.joinKey, roomId) : null;
  const joinKey = derived
    ? await sealJoinToken(derived, { memberId, tokenHash }, memberToken)
    : undefined;
  const outcome = await deps.changes.run(async () => {
    const room = deps.room();
    if (!room) return { ok: false as const, code: "ROOM_NOT_FOUND" as const };
    const admission = admitMember(
      room,
      {
        inviteCode: input.inviteCode,
        excluded: input.excluded,
        member: { memberId, nickname: input.nickname, tokenHash },
        joinKey,
      },
      deps.online(),
      Date.now(),
      deps.config,
    );
    if (admission.ok && admission.state) await deps.save(admission.state);
    return admission;
  });
  if (!outcome.ok) return outcome;
  if (!outcome.replay || !derived)
    return { ok: true, value: { memberToken, memberId } };
  return {
    ok: true,
    value: {
      memberToken: await openJoinToken(derived, outcome.replay),
      memberId: outcome.replay.memberId,
    },
  };
}

export async function reuseMember(
  room: () => RoomState | null,
  inviteCode: string,
  token: string,
): Promise<Result<ReuseRoomResponse>> {
  const hash = await hashToken(token);
  const current = room();
  const member =
    current?.inviteCode === inviteCode
      ? findMemberByTokenHash(current, hash)
      : undefined;
  if (!current || !member) return { ok: false, code: "ROOM_NOT_FOUND" };
  return {
    ok: true,
    value: { roomId: current.roomId, memberId: member.memberId, reused: true },
  };
}
