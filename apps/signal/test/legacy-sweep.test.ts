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
  PENDING_RESERVE_TTL_MS,
  SWEEP_CURSOR_KEY,
  SWEEP_PHASE_KEY,
  SWEEP_VERSION_KEY,
  codeKey,
  pendingKey,
  rotationKey,
} from "../src/runtime/workers/legacy-sweep";
import { connect, createRoom, post, runAlarmAt } from "./room-fixture";

const IDLE_TTL_MS = 100_000;
const DAY_MS = 24 * 60 * 60_000;

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

  test("GET /api/health 觸發巡檢：立即釋放逾 24h 與逾時空房／孤兒碼，缺 idleSince 舊房從當下起算 100 秒，保留活房", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = Date.now();

    // 1. 上版超過 24 小時且 idleSince: null 的舊房 → 立即關閉
    const expiredMaxAge = await seedLegacyRoom({
      inviteCode: "23456789",
      createdAt: now - DAY_MS - 60_000,
      lastSeenAt: now - DAY_MS - 60_000,
      idleSince: null,
    });

    // 2. 上版 idleSince 為 5 分鐘前的空房（舊版 30 分鐘未到期，新版 100 秒已到期）→ 立即關閉
    const staleIdle = await seedLegacyRoom({
      inviteCode: "ABCDEFGH",
      createdAt: now - 400_000,
      lastSeenAt: now - 300_000,
      idleSince: now - 300_000,
    });

    // 3. 上版直播 3 小時剛離線、缺 idleSince（lastSeenAt 為 3 小時前但未滿 24h）→ 不回推誤殺，改從當下起算 100 秒
    const missingIdle = await seedLegacyRoom({
      inviteCode: "JKMNPQRS",
      createdAt: now - 3 * 60 * 60_000,
      lastSeenAt: now - 3 * 60 * 60_000,
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
    const sweepStart = Date.now();
    expect(await runDurableObjectAlarm(directory)).toBe(true);

    // 逾 24h 與逾時空房都已立即關房、釋放邀請碼與清空 RoomDO storage
    for (const removed of [expiredMaxAge, staleIdle]) {
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

    // 缺 idleSince 且未滿 24h 的舊房先保留，自確認無人在線起算 100 秒後自動釋放
    expect(await directory.lookup("JKMNPQRS")).toBe(missingIdle.roomId);
    const missingState = await runInDurableObject(
      env.ROOM.getByName(missingIdle.roomId),
      async (_i, s) => ({
        room: await s.storage.get<RoomState>("state"),
        alarm: await s.storage.getAlarm(),
      }),
    );
    expect(missingState.room?.idleSince).toBeGreaterThanOrEqual(sweepStart);
    expect(missingState.alarm).toBe(
      missingState.room!.idleSince! + IDLE_TTL_MS,
    );
    await runAlarmAt(
      env.ROOM.getByName(missingIdle.roomId),
      missingState.alarm!,
    );
    expect(await directory.lookup("JKMNPQRS")).toBeNull();

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

  test("巡檢遇上建房中尚未 init 的預留邀請碼不可誤刪；逾期預留碼則清除", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const directory = env.INVITE_DIRECTORY.getByName("global");

    // 1. 建房剛呼叫 reserve()、RoomDO.init() 尚未完成
    const creatingRoomId = crypto.randomUUID();
    const creatingCode = await directory.reserve(creatingRoomId);

    // 2. 已超過保護期限的廢棄預留碼
    const staleRoomId = crypto.randomUUID();
    const staleCode = "BBBBBB22";
    await runInDurableObject(directory, async (_i, s) => {
      await s.storage.put(codeKey(staleCode), staleRoomId);
      await s.storage.put(
        pendingKey(staleCode),
        Date.now() - PENDING_RESERVE_TTL_MS - 1_000,
      );
      await s.storage.delete(SWEEP_VERSION_KEY);
      await s.storage.delete(SWEEP_PHASE_KEY);
      await s.storage.delete(SWEEP_CURSOR_KEY);
    });

    await directory.ensureLegacySweep();
    expect(await runDurableObjectAlarm(directory)).toBe(true);

    // 建房中的邀請碼仍保留；init 完成並 confirm 後可正常加入
    expect(await directory.lookup(creatingCode)).toBe(creatingRoomId);
    await env.ROOM.getByName(creatingRoomId).init({
      roomId: creatingRoomId,
      inviteCode: creatingCode,
      nickname: "房主",
    });
    await directory.confirm(creatingCode, creatingRoomId);
    const joined = await post("/api/rooms/join", {
      inviteCode: creatingCode,
      nickname: "朋友",
    });
    expect(joined.status).toBe(200);

    // 逾期的廢棄預留碼與其 pending 標記一併清掉
    expect(await directory.lookup(staleCode)).toBeNull();
    expect(
      await runInDurableObject(directory, (_i, s) =>
        s.storage.get(pendingKey(staleCode)),
      ),
    ).toBeUndefined();
  });

  test("邀請碼與換碼紀錄皆超過單批上限時，兩階段各自透過游標分批推進並在完成後清除 alarm", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const directory = env.INVITE_DIRECTORY.getByName("global");
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const codes = Array.from(
      { length: 25 },
      (_, i) => `AAAAAA${alphabet[Math.floor(i / 10)]}${alphabet[i % 10]}`,
    );
    const rotRoomIds = Array.from({ length: 22 }, () => crypto.randomUUID());
    await runInDurableObject(directory, async (_i, s) => {
      for (const code of codes) {
        await s.storage.put(codeKey(code), crypto.randomUUID());
      }
      for (const id of rotRoomIds) {
        await s.storage.put(rotationKey(id), { opId: "op", code: "CCCCCCCC" });
      }
      await s.storage.delete(SWEEP_VERSION_KEY);
      await s.storage.delete(SWEEP_PHASE_KEY);
      await s.storage.delete(SWEEP_CURSOR_KEY);
    });

    await directory.ensureLegacySweep();
    // 連續驅動 alarm 直到完成（總計 25 code + 22 rotation + 既有活房，分 3 批）
    let rounds = 0;
    while (
      (await runInDurableObject(directory, (_i, s) => s.storage.getAlarm())) !==
      null
    ) {
      expect(await runDurableObjectAlarm(directory)).toBe(true);
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(5);
    }
    expect(rounds).toBeGreaterThanOrEqual(3);

    const done = await runInDurableObject(directory, async (_i, s) => ({
      version: await s.storage.get<number>(SWEEP_VERSION_KEY),
      phase: await s.storage.get<string>(SWEEP_PHASE_KEY),
      cursor: await s.storage.get<string>(SWEEP_CURSOR_KEY),
      alarm: await s.storage.getAlarm(),
    }));
    expect(done).toEqual({
      version: LEGACY_SWEEP_VERSION,
      phase: undefined,
      cursor: undefined,
      alarm: null,
    });
    const resolved = await Promise.all(
      codes.map((code) => directory.lookup(code)),
    );
    expect(resolved.every((id) => id === null)).toBe(true);
    const leftRots = await runInDurableObject(directory, async (_i, s) =>
      Promise.all(rotRoomIds.map((id) => s.storage.get(rotationKey(id)))),
    );
    expect(leftRots.every((v) => v === undefined)).toBe(true);
  });

  test("巡檢遇到正在關房重試且 retry.at 尚未到期的 RoomDO 時，不提前消耗重試次數", async () => {
    const roomId = crypto.randomUUID();
    const futureRetry = Date.now() + 60_000;
    const stub = env.ROOM.getByName(roomId);
    await runInDurableObject(stub, async (instance, s) => {
      const closing = {
        roomId,
        reason: "expired" as const,
        inviteCodes: ["DDDDDD22"],
        rotation: null,
      };
      await s.storage.put("closing", closing);
      await s.storage.put("cleanupRetry", { attempts: 1, at: futureRetry });
      (instance as unknown as { closing: unknown }).closing = closing;
    });
    expect(await stub.reconcileLegacyRoom()).toBe("closed");
    const retryAfter = await runInDurableObject(stub, (_i, s) =>
      s.storage.get<{ attempts: number; at: number | null }>("cleanupRetry"),
    );
    expect(retryAfter).toEqual({ attempts: 1, at: futureRetry });
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
