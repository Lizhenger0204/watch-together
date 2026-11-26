import { DEFAULT_QUALITY } from "@project/shared";
import {
  SELF,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hashToken } from "../src/room/crypto";
import type { RoomState } from "../src/room/room";
import type { Env } from "../src/runtime/workers/env";
import { InviteDirectoryDO } from "../src/runtime/workers/invite-directory-do";
import {
  LEGACY_SWEEP_VERSION,
  SWEEP_CURSOR_KEY,
  SWEEP_VERSION_KEY,
  codeKey,
  rotationKey,
} from "../src/runtime/workers/legacy-sweep";
import { connect, createRoom } from "./room-fixture";

const IDLE_TTL_MS = 100_000;

async function seedLegacyRoom(options: {
  roomId?: string;
  inviteCode: string;
  createdAt: number;
  lastSeenAt: number;
  idleSince: number | null;
}) {
  const roomId = options.roomId ?? crypto.randomUUID();
  const hostToken = `token-${roomId}`;
  const state: RoomState = {
    roomId,
    createdAt: options.createdAt,
    locked: false,
    mode: "p2p",
    quality: DEFAULT_QUALITY,
    inviteCode: options.inviteCode,
    members: [
      {
        memberId: `host-${roomId}`,
        nickname: "舊版房主",
        role: "host",
        tokenHash: await hashToken(hostToken),
        joinedAt: options.createdAt,
        lastSeenAt: options.lastSeenAt,
      },
    ],
    stream: { live: false, title: null, startedAt: null },
    idleSince: options.idleSince,
  };
  await runInDurableObject(env.ROOM.getByName(roomId), async (instance, s) => {
    await s.storage.put("state", state);
    (instance as unknown as { room: RoomState | null }).room = state;
  });
  await runInDurableObject(
    env.INVITE_DIRECTORY.getByName("global"),
    async (_instance, s) => {
      await s.storage.put(codeKey(options.inviteCode), roomId);
      await s.storage.delete(SWEEP_VERSION_KEY);
    },
  );
  return { roomId, hostToken, inviteCode: options.inviteCode };
}

describe("上個版本未釋放的空房一次性巡檢", () => {
  afterEach(() => vi.restoreAllMocks());

  test("GET /api/health 觸發巡檢：釋放殭屍空房（idleSince: null）與逾時 30 分鐘空房、孤兒碼，保留活房", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = Date.now();

    // 1. 上版無連線且 idleSince: null 的殭屍空房（最後活動 5 分鐘前）
    const zombie = await seedLegacyRoom({
      inviteCode: "23456789",
      createdAt: now - 300_000,
      lastSeenAt: now - 300_000,
      idleSince: null,
    });

    // 2. 上版 idleSince 為 5 分鐘前的空房（舊版 30 分鐘未到期，新版 100 秒已到期）
    const staleIdle = await seedLegacyRoom({
      inviteCode: "ABCDEFGH",
      createdAt: now - 400_000,
      lastSeenAt: now - 300_000,
      idleSince: now - 300_000,
    });

    // 3. 上版無連線且 idleSince: null，但最後活動僅 30 秒前（尚未滿 100 秒，應保留並補齊期限）
    const recentOffline = await seedLegacyRoom({
      inviteCode: "JKMNPQRS",
      createdAt: now - 60_000,
      lastSeenAt: now - 30_000,
      idleSince: null,
    });

    // 4. 目錄殘留的孤兒 code:* 與 rotation:*（對應的 RoomDO 完全空）
    const orphanRoomId = crypto.randomUUID();
    const orphanCode = "TUVWXYZ2";
    const directory = env.INVITE_DIRECTORY.getByName("global");
    await runInDurableObject(directory, async (_i, s) => {
      await s.storage.put(codeKey(orphanCode), orphanRoomId);
      await s.storage.put(rotationKey(orphanRoomId), {
        opId: "old-op",
        code: orphanCode,
      });
      await s.storage.delete(SWEEP_VERSION_KEY);
    });

    // 5. 目前仍有人在線的活房間（不得被誤關）
    const active = await createRoom();
    const activeSocket = await connect(active.roomId);
    activeSocket.auth(active.hostToken);
    await activeSocket.next("room:snapshot");
    await runInDurableObject(directory, async (_i, s) => {
      await s.storage.delete(SWEEP_VERSION_KEY);
    });

    // 呼叫 /api/health 觸發巡檢排程並執行 alarm
    const health = await SELF.fetch("https://signal.test/api/health");
    expect(health.status).toBe(200);
    const sweepAlarm = await runInDurableObject(directory, (_i, s) =>
      s.storage.getAlarm(),
    );
    expect(sweepAlarm).not.toBeNull();
    expect(await runDurableObjectAlarm(directory)).toBe(true);

    // 殭屍空房與逾時空房都已關房、釋放邀請碼與清空 RoomDO storage
    for (const removed of [zombie, staleIdle]) {
      expect(await directory.lookup(removed.inviteCode)).toBeNull();
      const left = await runInDurableObject(
        env.ROOM.getByName(removed.roomId),
        async (_i, s) => ({
          size: (await s.storage.list()).size,
          alarm: await s.storage.getAlarm(),
        }),
      );
      expect(left).toEqual({ size: 0, alarm: null });
    }

    // 孤兒 code:* 與 rotation:* 已清除
    expect(await directory.lookup(orphanCode)).toBeNull();
    const orphanRotation = await runInDurableObject(directory, (_i, s) =>
      s.storage.get(rotationKey(orphanRoomId)),
    );
    expect(orphanRotation).toBeUndefined();

    // 不到 100 秒的離線房仍活著，但已補齊 idleSince 與縮短 alarm
    expect(await directory.lookup("JKMNPQRS")).toBe(recentOffline.roomId);
    const recentState = await runInDurableObject(
      env.ROOM.getByName(recentOffline.roomId),
      async (_i, s) => ({
        room: await s.storage.get<RoomState>("state"),
        alarm: await s.storage.getAlarm(),
      }),
    );
    expect(recentState.room?.idleSince).toBe(now - 30_000);
    expect(recentState.alarm).toBe(now - 30_000 + IDLE_TTL_MS);

    // 活房間維持在線
    expect(await directory.lookup(active.inviteCode)).toBe(active.roomId);
    activeSocket.send({ type: "ping" });
    expect(await activeSocket.next("pong")).toEqual({ type: "pong" });
    activeSocket.close();

    // 巡檢完成後標記 sweep:version 且清掉 alarm；再打 /api/health 不會重複排程
    const after = await runInDurableObject(directory, async (_i, s) => ({
      version: await s.storage.get<number>(SWEEP_VERSION_KEY),
      alarm: await s.storage.getAlarm(),
    }));
    expect(after).toEqual({ version: LEGACY_SWEEP_VERSION, alarm: null });

    expect((await SELF.fetch("https://signal.test/api/health")).status).toBe(
      200,
    );
    expect(
      await runInDurableObject(directory, (_i, s) => s.storage.getAlarm()),
    ).toBeNull();

    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringContaining('"directory.legacy_sweep_done"'),
    );
  });

  test("邀請碼數量超過單批上限時，分批透過游標推進並在完成後清除 alarm", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const directory = env.INVITE_DIRECTORY.getByName("global");
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const codes = Array.from(
      { length: 25 },
      (_, i) => `AAAAAA${alphabet[Math.floor(i / 10)]}${alphabet[i % 10]}`,
    );
    await runInDurableObject(directory, async (_i, s) => {
      for (const code of codes) {
        await s.storage.put(codeKey(code), crypto.randomUUID());
      }
      await s.storage.delete(SWEEP_VERSION_KEY);
      await s.storage.delete(SWEEP_CURSOR_KEY);
    });

    await directory.ensureLegacySweep();
    // 第一批 20 筆處理後會續排下一次 alarm
    expect(await runDurableObjectAlarm(directory)).toBe(true);
    expect(
      await runInDurableObject(directory, (_i, s) => s.storage.getAlarm()),
    ).not.toBeNull();

    // 第二批剩餘筆數完成後清掉游標與 alarm
    expect(await runDurableObjectAlarm(directory)).toBe(true);
    const done = await runInDurableObject(directory, async (_i, s) => ({
      version: await s.storage.get<number>(SWEEP_VERSION_KEY),
      cursor: await s.storage.get<string>(SWEEP_CURSOR_KEY),
      alarm: await s.storage.getAlarm(),
    }));
    expect(done).toEqual({
      version: LEGACY_SWEEP_VERSION,
      cursor: undefined,
      alarm: null,
    });
    const resolved = await Promise.all(
      codes.map((code) => directory.lookup(code)),
    );
    expect(resolved.every((id) => id === null)).toBe(true);
  });

  test("目錄實例休眠喚醒且帶有舊紀錄時，建構子會自動排定巡檢", async () => {
    const directory = env.INVITE_DIRECTORY.getByName("global");
    await runInDurableObject(directory, async (_i, state) => {
      await state.storage.put(codeKey("23456789"), crypto.randomUUID());
      await state.storage.delete(SWEEP_VERSION_KEY);
      await state.storage.deleteAlarm();
      const startup = vi.spyOn(state, "blockConcurrencyWhile");
      try {
        new InviteDirectoryDO(state, env as unknown as Env);
        expect(startup).toHaveBeenCalledOnce();
        await startup.mock.results[0]?.value;
      } finally {
        startup.mockRestore();
      }
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.deleteAlarm();
    });
  });
});
