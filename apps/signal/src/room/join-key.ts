import { JOIN_KEY_TTL_MS } from "@project/shared";
import type { RoomConfig } from "../config";
import { base64Url, fromBase64Url, timingSafeEqual } from "./crypto";
import { addMember, type Online, type RoomState } from "./room";

// 加入冪等（protocol.md「加入冪等」）：同一把 joinKey 在期限內重試，取回同一份成員結果。
// 只用標準 Web Crypto，不依賴 Workers。伺服器不保存鍵與 token 的明文：
// 鍵經 HKDF 導出查表識別與 AES-GCM 金鑰，token 以後者加密保存。

/** 存在 RoomState.joinKeys：與席位同一筆交易提交，關房時隨房間狀態刪除。 */
export type JoinKeyRecord = {
  /** HKDF 導出的查表識別（不是鍵本身）。 */
  id: string;
  memberId: string;
  /** 配置當時的 token 雜湊；成員被踢後重新加入會換成別的值。 */
  tokenHash: string;
  /** `base64url(iv).base64url(AES-GCM(token))`，附加資料為 memberId。 */
  sealed: string;
  expiresAt: number;
};

export type DerivedJoinKey = { id: string; key: CryptoKey };

const encoder = new TextEncoder();

export async function deriveJoinKey(
  joinKey: string,
  roomId: string,
): Promise<DerivedJoinKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(joinKey),
    "HKDF",
    false,
    ["deriveBits", "deriveKey"],
  );
  const params = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode(roomId),
    info: encoder.encode(info),
  });
  const id = await crypto.subtle.deriveBits(
    params("join-key/id"),
    material,
    256,
  );
  const key = await crypto.subtle.deriveKey(
    params("join-key/seal"),
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { id: base64Url(new Uint8Array(id)), key };
}

export async function sealJoinToken(
  derived: DerivedJoinKey,
  member: { memberId: string; tokenHash: string },
  token: string,
): Promise<Omit<JoinKeyRecord, "expiresAt">> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(member.memberId) },
    derived.key,
    encoder.encode(token),
  );
  return {
    id: derived.id,
    ...member,
    sealed: `${base64Url(iv)}.${base64Url(new Uint8Array(cipher))}`,
  };
}

export async function openJoinToken(
  derived: DerivedJoinKey,
  record: JoinKeyRecord,
): Promise<string> {
  const [iv = "", cipher = ""] = record.sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(iv),
      additionalData: encoder.encode(record.memberId),
    },
    derived.key,
    fromBase64Url(cipher),
  );
  return new TextDecoder().decode(plain);
}

/** 紀錄仍有效：未過期，且當時配置的成員還在、憑證沒換。 */
function isLive(state: RoomState, record: JoinKeyRecord, now: number) {
  if (now >= record.expiresAt) return false;
  const member = state.members.find((m) => m.memberId === record.memberId);
  return !!member && timingSafeEqual(member.tokenHash, record.tokenHash);
}

/** 逐筆比完、不提早結束，回應時間與命中第幾筆無關。 */
function findJoinKey(state: RoomState, id: string, now: number) {
  let found: JoinKeyRecord | undefined;
  for (const record of state.joinKeys ?? []) {
    if (timingSafeEqual(record.id, id) && isLive(state, record, now))
      found = record;
  }
  return found;
}

export type Admission =
  | { ok: true; state: RoomState; replay: null }
  | { ok: true; state: null; replay: JoinKeyRecord }
  | { ok: false; code: "ROOM_NOT_FOUND" | "ROOM_FULL" };

/**
 * 新加入：同一把鍵已配置過、仍有效就回傳那筆紀錄（不檢查鎖房、滿房與排除名單）；
 * 否則照 addMember 的規則配置，成功時記下這把鍵，並清掉過期或成員已不在的紀錄。
 */
export function admitMember(
  state: RoomState,
  input: Parameters<typeof addMember>[1] & {
    joinKey?: Omit<JoinKeyRecord, "expiresAt">;
  },
  online: Online,
  now: number,
  config: Pick<RoomConfig, "maxMembers" | "staleMemberMs">,
): Admission {
  const { joinKey } = input;
  if (joinKey && input.inviteCode === state.inviteCode) {
    const replay = findJoinKey(state, joinKey.id, now);
    if (replay) return { ok: true, state: null, replay };
  }
  const outcome = addMember(state, input, online, now, config);
  if (!outcome.ok) return outcome;
  if (!joinKey) return { ...outcome, replay: null };
  const next = outcome.state;
  const kept = (next.joinKeys ?? []).filter(
    (record) => record.id !== joinKey.id && isLive(next, record, now),
  );
  return {
    ok: true,
    replay: null,
    state: {
      ...next,
      joinKeys: [...kept, { ...joinKey, expiresAt: now + JOIN_KEY_TTL_MS }],
    },
  };
}
