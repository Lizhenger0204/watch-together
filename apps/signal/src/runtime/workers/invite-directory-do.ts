import { DurableObject } from "cloudflare:workers";
import { generateInviteCode } from "../../room/crypto";
import type { Env } from "./env";

const key = (code: string) => `code:${code}`;

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

  /** 只刪除仍指向這個房間的碼，避免誤刪。 */
  async release(code: string, roomId: string): Promise<void> {
    if ((await this.ctx.storage.get(key(code))) === roomId) {
      await this.ctx.storage.delete(key(code));
    }
  }

  async replace(oldCode: string, roomId: string): Promise<string> {
    const code = await this.reserve(roomId);
    await this.release(oldCode, roomId);
    return code;
  }
}
