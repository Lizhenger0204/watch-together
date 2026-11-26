import type { Env } from "./env";

export const SWEEP_VERSION_KEY = "sweep:version";
export const SWEEP_CURSOR_KEY = "sweep:cursor";
export const LEGACY_SWEEP_VERSION = 1;
export const SWEEP_BATCH_SIZE = 20;
export const SWEEP_DELAY_MS = 5_000;
export const SWEEP_RETRY_MS = 30_000;

export const codeKey = (code: string) => `code:${code}`;
export const rotationKey = (roomId: string) => `rotation:${roomId}`;

export type SweepResult = {
  checked: number;
  closed: number;
  orphans: number;
  done: boolean;
};

export async function deleteIfOwned(
  txn: DurableObjectTransaction,
  code: string,
  roomId: string,
) {
  if ((await txn.get(codeKey(code))) === roomId) {
    await txn.delete(codeKey(code));
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

/** 分批喚醒現有 RoomDO，釋放上個版本殘留的空房與孤兒邀請碼。 */
export async function sweepLegacyRooms(
  storage: DurableObjectStorage,
  env: Env,
): Promise<SweepResult> {
  const version = (await storage.get<number>(SWEEP_VERSION_KEY)) ?? 0;
  if (version >= LEGACY_SWEEP_VERSION) {
    await storage.deleteAlarm();
    return { checked: 0, closed: 0, orphans: 0, done: true };
  }
  const cursor = await storage.get<string>(SWEEP_CURSOR_KEY);
  const entries = await storage.list<string>({
    prefix: "code:",
    ...(cursor ? { startAfter: cursor } : {}),
    limit: SWEEP_BATCH_SIZE,
  });

  const aliveRooms = new Set<string>();
  const checkedRooms = new Set<string>();
  let closed = 0;
  let orphans = 0;
  let lastKey: string | undefined;

  try {
    for (const [key, roomId] of entries) {
      lastKey = key;
      const code = key.slice("code:".length);
      if (aliveRooms.has(roomId)) continue;
      checkedRooms.add(roomId);
      const outcome = await env.ROOM.getByName(roomId).reconcileLegacyRoom();
      if (outcome === "alive") {
        aliveRooms.add(roomId);
        continue;
      }
      if (outcome === "orphan") {
        await storage.transaction(async (txn) => {
          await deleteIfOwned(txn, code, roomId);
          await txn.delete(rotationKey(roomId));
        });
        orphans += 1;
      } else {
        closed += 1;
      }
    }

    if (entries.size === SWEEP_BATCH_SIZE && lastKey) {
      await storage.transaction(async (txn) => {
        await txn.put(SWEEP_CURSOR_KEY, lastKey);
        await txn.setAlarm(Date.now() + SWEEP_DELAY_MS);
      });
      return { checked: checkedRooms.size, closed, orphans, done: false };
    }

    const rotations = await storage.list({ prefix: "rotation:" });
    for (const [key] of rotations) {
      const roomId = key.slice("rotation:".length);
      if (aliveRooms.has(roomId)) continue;
      checkedRooms.add(roomId);
      const outcome = await env.ROOM.getByName(roomId).reconcileLegacyRoom();
      if (outcome === "alive") {
        aliveRooms.add(roomId);
        continue;
      }
      if (outcome === "orphan") {
        await storage.delete(key);
        orphans += 1;
      }
    }
  } catch {
    await storage.setAlarm(Date.now() + SWEEP_RETRY_MS);
    return { checked: checkedRooms.size, closed, orphans, done: false };
  }

  await storage.transaction(async (txn) => {
    await txn.put(SWEEP_VERSION_KEY, LEGACY_SWEEP_VERSION);
    await txn.delete(SWEEP_CURSOR_KEY);
    await txn.deleteAlarm();
  });
  console.log(
    JSON.stringify({
      event: "directory.legacy_sweep_done",
      checked: checkedRooms.size,
      closed,
      orphans,
    }),
  );
  return { checked: checkedRooms.size, closed, orphans, done: true };
}
