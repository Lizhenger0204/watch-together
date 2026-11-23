import { DurableObject } from "cloudflare:workers";
import { generateInviteCode } from "../../room/crypto";
import type { Env } from "./env";

const key = (code: string) => `code:${code}`;
const rotationKey = (roomId: string) => `rotation:${roomId}`;
type Rotation = { opId: string; code: string };

/**
 * 邀請碼 → roomId 對照表（單一實例，強一致）。
 * 不用 KV：KV 是最終一致，重新產生後舊碼可能還查得到。
 */
export class InviteDirectoryDO extends DurableObject<Env> {
  async reserve(roomId: string): Promise<string> {
    for (;;) {
      const code = generateInviteCode();
      if ((await this.ctx.storage.get(key(code))) === undefined) {
        await this.ctx.storage.put(key(code), roomId);
        return code;
      }
    }
  }

  async lookup(code: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(key(code))) ?? null;
  }

  /** 只刪除仍指向這個房間的碼，避免誤刪。關房時呼叫，一併忘掉這個房間的換碼紀錄。 */
  async release(code: string, roomId: string): Promise<void> {
    await this.deleteIfOwned(code, roomId);
    await this.ctx.storage.delete(rotationKey(roomId));
  }

  /**
   * 換碼：保留新碼、釋放舊碼。可重複呼叫：同一個 `opId` 再呼叫會回傳上次換到的碼，
   * 讓 RoomDO 在 RPC 回應遺失後查回結果（每個房間只記最後一次）。
   * 中間沒有其他 I/O，storage 寫入會合併成一次提交。
   */
  async replace(
    oldCode: string,
    roomId: string,
    opId: string,
  ): Promise<string> {
    const last = await this.ctx.storage.get<Rotation>(rotationKey(roomId));
    if (last?.opId === opId) return last.code;
    const code = await this.reserve(roomId);
    await this.deleteIfOwned(oldCode, roomId);
    await this.ctx.storage.put(rotationKey(roomId), {
      opId,
      code,
    } satisfies Rotation);
    return code;
  }

  private async deleteIfOwned(code: string, roomId: string) {
    if ((await this.ctx.storage.get(key(code))) === roomId) {
      await this.ctx.storage.delete(key(code));
    }
  }
}
