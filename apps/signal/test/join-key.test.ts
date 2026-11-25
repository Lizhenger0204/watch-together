import {
  JOIN_KEY_TTL_MS,
  createRoomResponseSchema,
  joinRoomResponseSchema,
} from "@project/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { errorBody } from "../src/errors";
import { generateToken } from "../src/room/crypto";
import type { RoomState } from "../src/room/room";
import { workersServices } from "../src/runtime/workers/services";
import type { SerialQueue } from "../src/runtime/workers/serial-queue";
import { deferred, hostSocket } from "./room-fixture";

// protocol.md「加入冪等」：同一把 joinKey 重試時沿用已配置的席位。

const app = createApp((c) => ({
  ...workersServices(c),
  joinLimiter: { allow: async () => true },
}));
const joinPath = "/api/rooms/join";

function post(path: string, body: unknown, token?: string) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function room() {
  const res = await post("/api/rooms", { nickname: "房主" });
  return createRoomResponseSchema.parse(await res.json());
}

async function join(body: Record<string, unknown>) {
  const res = await post(joinPath, { nickname: "朋友", ...body });
  return { status: res.status, body: (await res.json()) as unknown };
}

function state(roomId: string) {
  return runInDurableObject(env.ROOM.getByName(roomId), (_i, s) =>
    s.storage.get<RoomState>("state"),
  );
}

async function memberCount(roomId: string) {
  return (await state(roomId))?.members.length;
}

test("同一把鍵重試：回傳同一份身份，不再多配一席", async () => {
  const { roomId, inviteCode } = await room();
  const joinKey = generateToken();
  const first = await join({ inviteCode, joinKey });
  expect(first.status).toBe(200);
  const again = await join({ inviteCode, joinKey, nickname: "改名" });
  expect(again).toEqual(first);
  expect(joinRoomResponseSchema.parse(again.body).roomId).toBe(roomId);
  expect(await memberCount(roomId)).toBe(2);
  const members = (await state(roomId))?.members ?? [];
  expect(members.map((m) => m.nickname)).toEqual(["房主", "朋友"]);
  // 不同的鍵是另一次加入。
  const other = await join({ inviteCode, joinKey: generateToken() });
  expect(other.status).toBe(200);
  expect(await memberCount(roomId)).toBe(3);
});

test("同一把鍵同時送出兩筆：只配一席，兩筆結果相同", async () => {
  const { roomId, inviteCode } = await room();
  const joinKey = generateToken();
  const [a, b] = await Promise.all([
    join({ inviteCode, joinKey }),
    join({ inviteCode, joinKey }),
  ]);
  expect(a.status).toBe(200);
  expect(b).toEqual(a);
  expect(await memberCount(roomId)).toBe(2);
});

test("第一筆已決定配位、尚未提交時收到同鍵的第二筆：仍只配一席", async () => {
  const { roomId, inviteCode } = await room();
  await runInDurableObject(env.ROOM.getByName(roomId), async (instance, s) => {
    const changes = (instance as unknown as { changes: SerialQueue }).changes;
    const entered = deferred();
    const resume = deferred();
    const secondQueued = deferred();
    const transact = s.storage.transaction.bind(s.storage);
    const gate = vi
      .spyOn(s.storage, "transaction")
      .mockImplementationOnce(async (work) => {
        entered.resolve();
        await resume.promise;
        return transact(work);
      });
    const run = changes.run.bind(changes);
    let queued = 0;
    const queue = vi.spyOn(changes, "run").mockImplementation((work) => {
      if (++queued === 2) secondQueued.resolve();
      return run(work);
    });
    try {
      const joinKey = generateToken();
      const first = instance.join({ inviteCode, nickname: "甲", joinKey });
      await entered.promise;
      const second = instance.join({ inviteCode, nickname: "乙", joinKey });
      await secondQueued.promise;
      resume.resolve();
      const [a, b] = await Promise.all([first, second]);
      expect(a.ok).toBe(true);
      expect(b).toEqual(a);
      const saved = await s.storage.get<RoomState>("state");
      expect(saved?.members.map((m) => m.nickname)).toEqual(["房主", "甲"]);
    } finally {
      resume.resolve();
      gate.mockRestore();
      queue.mockRestore();
    }
  });
});

test("重放不受鎖房、滿房與排除名單影響", async () => {
  const created = await room();
  const { roomId, inviteCode } = created;
  const joinKey = generateToken();
  const first = await join({ inviteCode, joinKey });
  for (let i = 0; i < 6; i++)
    expect((await join({ inviteCode })).status).toBe(200);
  expect((await join({ inviteCode })).status).toBe(409);
  expect(await join({ inviteCode, joinKey, excludeRoomIds: [roomId] })).toEqual(
    first,
  );
  const host = await hostSocket(created);
  host.send({ type: "room:update", locked: true, reqId: "lock" });
  expect(await host.next("ack")).toMatchObject({ reqId: "lock", ok: true });
  expect((await join({ inviteCode })).status).toBe(404);
  expect(await join({ inviteCode, joinKey })).toEqual(first);
  expect(await memberCount(roomId)).toBe(8);
  host.close();
});

test("超過期限的鍵視為新加入", async () => {
  const { roomId, inviteCode } = await room();
  const joinKey = generateToken();
  const first = await join({ inviteCode, joinKey });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + JOIN_KEY_TTL_MS);
  try {
    const later = await join({ inviteCode, joinKey });
    expect(later.status).toBe(200);
    expect(later).not.toEqual(first);
    const records = (await state(roomId))?.joinKeys ?? [];
    expect(records).toHaveLength(1); // 過期的紀錄已清掉
  } finally {
    clock.mockRestore();
  }
  expect(await memberCount(roomId)).toBe(3);
});

test("當時配置的成員已被踢出：重放照一般新加入處理", async () => {
  const created = await room();
  const { inviteCode } = created;
  const joinKey = generateToken();
  const first = joinRoomResponseSchema.parse(
    (await join({ inviteCode, joinKey })).body,
  );
  const host = await hostSocket(created);
  host.send({ type: "room:kick", memberId: first.memberId, reqId: "kick" });
  expect(await host.next("ack")).toMatchObject({ reqId: "kick", ok: true });
  host.close();
  const again = joinRoomResponseSchema.parse(
    (await join({ inviteCode, joinKey })).body,
  );
  expect(again.memberId).not.toBe(first.memberId);
  expect(again.memberToken).not.toBe(first.memberToken);
  // 被踢成員的舊紀錄已清掉，只剩這次的。
  const records = (await state(created.roomId))?.joinKeys ?? [];
  expect(records.map((r) => r.memberId)).toEqual([again.memberId]);
});

test("重新產生邀請碼後，舊碼帶同一把鍵也回相同的 404", async () => {
  const { inviteCode, roomId, hostToken } = await room();
  const joinKey = generateToken();
  await join({ inviteCode, joinKey });
  const res = await post(
    `/api/rooms/${roomId}/invite-code`,
    undefined,
    hostToken,
  );
  expect(res.status).toBe(200);
  expect(await join({ inviteCode, joinKey })).toEqual({
    status: 404,
    body: errorBody("ROOM_NOT_FOUND"),
  });
});

test("鍵格式錯誤回 400；沿用請求忽略鍵", async () => {
  const { roomId, inviteCode, hostToken, memberId } = await room();
  expect(await join({ inviteCode, joinKey: "short" })).toEqual({
    status: 400,
    body: errorBody("BAD_REQUEST"),
  });
  const reused = await post(
    joinPath,
    {
      inviteCode,
      nickname: "房主",
      existingRoomId: roomId,
      joinKey: generateToken(),
    },
    hostToken,
  );
  expect(await reused.json()).toEqual({ roomId, memberId, reused: true });
  expect(await memberCount(roomId)).toBe(1);
});

test("storage 不保存鍵與 token 的明文；鍵不能在別的房間取回身份", async () => {
  const a = await room();
  const b = await room();
  const joinKey = generateToken();
  const joined = joinRoomResponseSchema.parse(
    (await join({ inviteCode: a.inviteCode, joinKey })).body,
  );
  const saved = JSON.stringify(
    await runInDurableObject(env.ROOM.getByName(a.roomId), async (_i, s) => [
      ...(await s.storage.list()),
    ]),
  );
  expect(saved).not.toContain(joinKey);
  expect(saved).not.toContain(joined.memberToken);
  const other = joinRoomResponseSchema.parse(
    (await join({ inviteCode: b.inviteCode, joinKey })).body,
  );
  expect(other.memberToken).not.toBe(joined.memberToken);
  expect(other.roomId).toBe(b.roomId);
});
