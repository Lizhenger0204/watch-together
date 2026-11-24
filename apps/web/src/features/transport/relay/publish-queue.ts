/**
 * 同一房間的 WHIP 發布依序進行（docs/specs/streaming.md §4）。
 *
 * 停播、重開、切模式與重連都會建立新的 transport，但同一頁面內共用這個佇列：
 * - 一次只有一個發布佔用「輪次」，從 POST 前一直佔到它的資源 DELETE 完成。
 *   下一次 POST 要等上一輪釋放，所以晚到的舊 WHIP 不會蓋掉新發布。
 * - DELETE 重試用盡仍失敗的資源留在 `leftovers`。下一輪 POST 前先再試一次，
 *   還是清不掉就不送 POST（後續建立須等待清理完成）。
 */
import { TransportError } from "../common";
import { deleteResource } from "./http";

export class PublishQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly leftovers = new Set<string>();

  /** 等到輪到自己，回傳只會生效一次的釋放函式。 */
  async turn(): Promise<() => void> {
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => done);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /** 刪除這一輪的資源；清不掉就留給下一輪。 */
  async remove(location: string, token: string) {
    const outcome = await deleteResource(location, token);
    if (outcome === "failed") this.leftovers.add(location);
  }

  /** 下一次 POST 前清掉之前留下的資源；仍有清不掉的就丟 RELAY_FAILED。 */
  async flushLeftovers(token: string) {
    for (const location of [...this.leftovers]) {
      const outcome = await deleteResource(location, token);
      if (outcome !== "failed") this.leftovers.delete(location);
    }
    if (this.leftovers.size > 0) {
      throw new TransportError(
        "RELAY_FAILED",
        "上一次的轉發還沒清理完成，請稍後再試。",
      );
    }
  }

  get pendingCleanup() {
    return this.leftovers.size;
  }
}

const queues = new Map<string, PublishQueue>();

/** 同一頁面內，同一房間共用一個佇列。 */
export function publishQueue(roomId: string) {
  let queue = queues.get(roomId);
  if (!queue) {
    queue = new PublishQueue();
    queues.set(roomId, queue);
  }
  return queue;
}

/** 測試用：清空所有房間的佇列。 */
export function resetPublishQueues() {
  queues.clear();
}
