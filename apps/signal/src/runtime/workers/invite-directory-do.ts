import { DurableObject } from "cloudflare:workers";
import { generateInviteCode } from "../../room/crypto";
import type { Env } from "./env";
import {
  armLegacySweepIfNeeded,
  codeKey,
  deleteIfOwned,
  pendingKey,
  rotationKey,
  sweepLegacyRooms,
} from "./legacy-sweep";

type Rotation = { opId: string; code: string };

async function reserveCode(
  txn: DurableObjectTransaction,
  roomId: string,
  markPending = false,
) {
  for (;;) {
    const code = generateInviteCode();
    if ((await txn.get(codeKey(code))) === undefined) {
      await txn.put(codeKey(code), roomId);
      if (markPending) await txn.put(pendingKey(code), Date.now());
      return code;
    }
  }
}

/**
 * 邀請碼 → roomId 對照表（單一實例，強一致）。
 * 不用 KV：KV 是最終一致，重新產生後舊碼可能還查得到。
 */
export class InviteDirectoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => armLegacySweepIfNeeded(ctx.storage));
  }

  async ensureLegacySweep(): Promise<void> {
    await armLegacySweepIfNeeded(this.ctx.storage);
  }

  async sweepLegacyRooms() {
    return sweepLegacyRooms(this.ctx.storage, this.env);
  }

  override async alarm(): Promise<void> {
    await sweepLegacyRooms(this.ctx.storage, this.env);
  }

  async reserve(roomId: string): Promise<string> {
    return this.ctx.storage.transaction((txn) =>
      reserveCode(txn, roomId, true),
    );
  }

  /** RoomDO.init 完成後呼叫，清除建房中的預留保護標記。 */
  async confirm(code: string, roomId: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get(codeKey(code))) === roomId) {
        await txn.delete(pendingKey(code));
      }
    });
  }

  async lookup(code: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(codeKey(code))) ?? null;
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
