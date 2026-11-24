import { DurableObject } from "cloudflare:workers";
import { generateInviteCode } from "../../room/crypto";
import type { Env } from "./env";

const key = (code: string) => `code:${code}`;
const rotationKey = (roomId: string) => `rotation:${roomId}`;
type Rotation = { opId: string; code: string };

async function reserveCode(txn: DurableObjectTransaction, roomId: string) {
  for (;;) {
    const code = generateInviteCode();
    if ((await txn.get(key(code))) === undefined) {
      await txn.put(key(code), roomId);
      return code;
    }
  }
}

async function deleteIfOwned(
  txn: DurableObjectTransaction,
  code: string,
  roomId: string,
) {
  if ((await txn.get(key(code))) === roomId) await txn.delete(key(code));
}

/**
 * 邀請碼 → roomId 對照表（單一實例，強一致）。
 * 不用 KV：KV 是最終一致，重新產生後舊碼可能還查得到。
 */
export class InviteDirectoryDO extends DurableObject<Env> {
  async reserve(roomId: string): Promise<string> {
    return this.ctx.storage.transaction((txn) => reserveCode(txn, roomId));
  }

  async lookup(code: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(key(code))) ?? null;
  }

  /** 只刪除仍指向這個房間的碼，避免誤刪。關房時呼叫，一併忘掉這個房間的換碼紀錄。 */
  async release(code: string, roomId: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await deleteIfOwned(txn, code, roomId);
      await txn.delete(rotationKey(roomId));
    });
  }

  /**
   * 換碼：保留新碼、釋放舊碼。可重複呼叫：同一個 `opId` 再呼叫會回傳上次換到的碼，
   * 讓 RoomDO 在 RPC 回應遺失後查回結果（每個房間只記最後一次）。
   */
  async replace(
    oldCode: string,
    roomId: string,
    opId: string,
  ): Promise<string> {
    return this.ctx.storage.transaction(async (txn) => {
      const last = await txn.get<Rotation>(rotationKey(roomId));
      if (last?.opId === opId) return last.code;
      const code = await reserveCode(txn, roomId);
      await deleteIfOwned(txn, oldCode, roomId);
      await txn.put(rotationKey(roomId), { opId, code } satisfies Rotation);
      return code;
    });
  }
}
