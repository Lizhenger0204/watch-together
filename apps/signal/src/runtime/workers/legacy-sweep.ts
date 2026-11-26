import type { Env } from "./env";

export const SWEEP_VERSION_KEY = "sweep:version";
export const SWEEP_PHASE_KEY = "sweep:phase";
export const SWEEP_CURSOR_KEY = "sweep:cursor";
export const SWEEP_RETRIES_KEY = "sweep:retries";
export const LEGACY_SWEEP_VERSION = 1;
export const SWEEP_BATCH_SIZE = 20;
export const SWEEP_DELAY_MS = 5_000;
export const SWEEP_RETRY_MS = 30_000;
export const MAX_SWEEP_RETRIES = 5;
/** 建房預留邀請碼至 RoomDO.init 完成的保護期限，期間巡檢不可誤判為孤兒。 */
export const PENDING_RESERVE_TTL_MS = 60_000;

export type SweepPhase = "code" | "rotation";

export const codeKey = (code: string) => `code:${code}`;
export const pendingKey = (code: string) => `pending:${code}`;
export const rotationKey = (roomId: string) => `rotation:${roomId}`;

export type SweepResult = {
  checked: number;
  closed: number;
  orphans: number;
  failed: number;
  done: boolean;
};

export async function deleteIfOwned(
  txn: DurableObjectTransaction,
  code: string,
  roomId: string,
) {
  if ((await txn.get(codeKey(code))) === roomId) {
    await txn.delete(codeKey(code));
    await txn.delete(pendingKey(code));
  }
}

/** 初次喚醒或收到 health 檢查時，若目錄已有舊紀錄且尚未完成巡檢，排定一次 alarm。 */
export async function armLegacySweepIfNeeded(
  storage: DurableObjectStorage,
): Promise<void> {
  const version = (await storage.get<number>(SWEEP_VERSION_KEY)) ?? 0;
  if (version >= LEGACY_SWEEP_VERSION) return;
  const [codes, rotations] = await Promise.all([
    storage.list({ prefix: "code:", limit: 1 }),
    storage.list({ prefix: "rotation:", limit: 1 }),
  ]);
  if (codes.size === 0 && rotations.size === 0) {
    // 全新環境或空測試目錄：直接標記完成，不排 alarm。
    await storage.put(SWEEP_VERSION_KEY, LEGACY_SWEEP_VERSION);
    return;
  }
  if ((await storage.getAlarm()) === null) {
    await storage.setAlarm(Date.now() + SWEEP_DELAY_MS);
  }
}

async function scheduleNextBatch(
  storage: DurableObjectStorage,
  phase: SweepPhase,
  cursor: string | null,
  delayMs: number,
  retries?: number,
) {
  await storage.transaction(async (txn) => {
    await txn.put(SWEEP_PHASE_KEY, phase);
    if (cursor === null) await txn.delete(SWEEP_CURSOR_KEY);
    else await txn.put(SWEEP_CURSOR_KEY, cursor);
    if (retries !== undefined) await txn.put(SWEEP_RETRIES_KEY, retries);
    await txn.setAlarm(Date.now() + delayMs);
  });
}

/** 分批喚醒現有 RoomDO，釋放上個版本殘留的空房與孤兒邀請碼（code 與 rotation 皆有界分批）。 */
export async function sweepLegacyRooms(
  storage: DurableObjectStorage,
  env: Env,
): Promise<SweepResult> {
  const version = (await storage.get<number>(SWEEP_VERSION_KEY)) ?? 0;
  if (version >= LEGACY_SWEEP_VERSION) {
    await storage.deleteAlarm();
    return { checked: 0, closed: 0, orphans: 0, failed: 0, done: true };
  }

  const phase = (await storage.get<SweepPhase>(SWEEP_PHASE_KEY)) ?? "code";
  let cursor = (await storage.get<string>(SWEEP_CURSOR_KEY)) ?? null;
  const retries = (await storage.get<number>(SWEEP_RETRIES_KEY)) ?? 0;

  const aliveRooms = new Set<string>();
  const checkedRooms = new Set<string>();
  let closed = 0;
  let orphans = 0;
  let failed = 0;
  let budget = SWEEP_BATCH_SIZE;

  if (phase === "code") {
    const entries = await storage.list<string>({
      prefix: "code:",
      ...(cursor ? { startAfter: cursor } : {}),
      limit: budget,
    });
    let lastKey: string | null = null;
    for (const [key, roomId] of entries) {
      lastKey = key;
      budget -= 1;
      const code = key.slice("code:".length);
      if (aliveRooms.has(roomId)) continue;
      checkedRooms.add(roomId);
      let outcome: "alive" | "closed" | "orphan";
      try {
        outcome = await env.ROOM.getByName(roomId).reconcileLegacyRoom();
      } catch (error) {
        failed += 1;
        console.log(
          JSON.stringify({
            event: "directory.legacy_sweep_item_error",
            phase: "code",
            message: String(error),
          }),
        );
        continue;
      }
      if (outcome === "alive") {
        aliveRooms.add(roomId);
        continue;
      }
      if (outcome === "orphan") {
        const pendingAt = await storage.get<number>(pendingKey(code));
        if (
          pendingAt !== undefined &&
          Date.now() - pendingAt < PENDING_RESERVE_TTL_MS
        ) {
          // 正在建房中的預留碼，保留不刪。
          aliveRooms.add(roomId);
          continue;
        }
        await storage.transaction(async (txn) => {
          await deleteIfOwned(txn, code, roomId);
          await txn.delete(rotationKey(roomId));
        });
        orphans += 1;
      } else {
        closed += 1;
      }
    }

    if (entries.size === SWEEP_BATCH_SIZE && lastKey !== null) {
      await scheduleNextBatch(storage, "code", lastKey, SWEEP_DELAY_MS);
      return {
        checked: checkedRooms.size,
        closed,
        orphans,
        failed,
        done: false,
      };
    }

    cursor = null;
    if (budget <= 0) {
      await scheduleNextBatch(storage, "rotation", null, SWEEP_DELAY_MS);
      return {
        checked: checkedRooms.size,
        closed,
        orphans,
        failed,
        done: false,
      };
    }
  }

  const rotations = await storage.list({
    prefix: "rotation:",
    ...(cursor ? { startAfter: cursor } : {}),
    limit: budget,
  });
  let lastRotationKey: string | null = null;
  for (const [key] of rotations) {
    lastRotationKey = key;
    const roomId = key.slice("rotation:".length);
    if (aliveRooms.has(roomId)) continue;
    checkedRooms.add(roomId);
    let outcome: "alive" | "closed" | "orphan";
    try {
      outcome = await env.ROOM.getByName(roomId).reconcileLegacyRoom();
    } catch (error) {
      failed += 1;
      console.log(
        JSON.stringify({
          event: "directory.legacy_sweep_item_error",
          phase: "rotation",
          message: String(error),
        }),
      );
      continue;
    }
    if (outcome === "alive") {
      aliveRooms.add(roomId);
      continue;
    }
    if (outcome === "orphan") {
      await storage.delete(key);
      orphans += 1;
    }
  }

  if (rotations.size === budget && lastRotationKey !== null) {
    await scheduleNextBatch(
      storage,
      "rotation",
      lastRotationKey,
      SWEEP_DELAY_MS,
    );
    return {
      checked: checkedRooms.size,
      closed,
      orphans,
      failed,
      done: false,
    };
  }

  if (failed > 0 && retries < MAX_SWEEP_RETRIES) {
    await scheduleNextBatch(storage, "code", null, SWEEP_RETRY_MS, retries + 1);
    return {
      checked: checkedRooms.size,
      closed,
      orphans,
      failed,
      done: false,
    };
  }

  await storage.transaction(async (txn) => {
    await txn.put(SWEEP_VERSION_KEY, LEGACY_SWEEP_VERSION);
    await txn.delete(SWEEP_PHASE_KEY);
    await txn.delete(SWEEP_CURSOR_KEY);
    await txn.delete(SWEEP_RETRIES_KEY);
    await txn.deleteAlarm();
  });
  console.log(
    JSON.stringify({
      event: "directory.legacy_sweep_done",
      checked: checkedRooms.size,
      closed,
      orphans,
      failed,
    }),
  );
  return {
    checked: checkedRooms.size,
    closed,
    orphans,
    failed,
    done: true,
  };
}
