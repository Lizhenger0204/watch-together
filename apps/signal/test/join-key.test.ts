import {
  JOIN_KEY_TTL_MS,
  createRoomResponseSchema,
  errorResponseSchema,
  joinRoomResponseSchema,
  regenerateInviteCodeResponseSchema,
  type ErrorCode,
} from "@project/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { errorBody } from "../src/errors";
import { generateToken } from "../src/room/crypto";
import type { RoomState } from "../src/room/room";
import { workersServices } from "../src/runtime/workers/services";
import type { SerialQueue } from "../src/runtime/workers/serial-queue";
import { connect, deferred, hostSocket } from "./room-fixture";

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

/** 用布林比對身份回應，避免斷言失敗時在輸出中印出測試憑證。 */
function sameJoinResponse(
  a: { status: number; body: unknown },
  b: { status: number; body: unknown },
) {
  if (a.status !== b.status) return false;
  const pa = joinRoomResponseSchema.safeParse(a.body);
  const pb = joinRoomResponseSchema.safeParse(b.body);
  return (
    pa.success &&
    pb.success &&
    pa.data.roomId === pb.data.roomId &&
    pa.data.memberId === pb.data.memberId &&
    pa.data.memberToken === pb.data.memberToken
  );
}

test("同一把鍵重試：回傳同一份身份，不再多配一席", async () => {
  const { roomId, inviteCode } = await room();
  const joinKey = generateToken();
  const first = await join({ inviteCode, joinKey });
  expect(first.status).toBe(200);
  const again = await join({ inviteCode, joinKey, nickname: "改名" });
  expect(sameJoinResponse(again, first)).toBe(true);
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
  expect(sameJoinResponse(b, a)).toBe(true);
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
      expect(a.ok && b.ok).toBe(true);
      expect(
        a.ok &&
          b.ok &&
          a.value.memberId === b.value.memberId &&
          a.value.memberToken === b.value.memberToken,
      ).toBe(true);
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
  expect(
    sameJoinResponse(
      await join({ inviteCode, joinKey, excludeRoomIds: [roomId] }),
      first,
    ),
  ).toBe(true);
  const host = await hostSocket(created);
  host.send({ type: "room:update", locked: true, reqId: "lock" });
  expect(await host.next("ack")).toMatchObject({ reqId: "lock", ok: true });
  expect((await join({ inviteCode })).status).toBe(404);
  expect(sameJoinResponse(await join({ inviteCode, joinKey }), first)).toBe(
    true,
  );
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
    expect(sameJoinResponse(later, first)).toBe(false);
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
  expect(again.memberId === first.memberId).toBe(false);
  expect(again.memberToken === first.memberToken).toBe(false);
  // 被踢成員的舊紀錄已清掉，只剩這次的。
  const records = (await state(created.roomId))?.joinKeys ?? [];
  expect(records.map((r) => r.memberId)).toEqual([again.memberId]);
});

/** 驗證錯誤回應時不把整份 body 丟進 toEqual，避免意外回 200 時印出 memberToken。 */
function expectErrorResponse(
  res: { status: number; body: unknown },
  status: number,
  code: ErrorCode,
) {
  expect(res.status).toBe(status);
  const parsed = errorResponseSchema.safeParse(res.body);
  const expected = errorBody(code).error;
  expect(
    parsed.success &&
      parsed.data.error.code === expected.code &&
      parsed.data.error.message === expected.message,
  ).toBe(true);
}

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
  expectErrorResponse(
    await join({ inviteCode, joinKey }),
    404,
    "ROOM_NOT_FOUND",
  );
});

test("重新產生邀請碼後，舊碼配發的紀錄作廢：新碼帶舊鍵受鎖房與排除名單限制、原成員可沿用，且換碼版本遞增", async () => {
  const created = await room();
  const keyOpen = generateToken();
  const keyExcluded = generateToken();
  const keyLocked = generateToken();
  const first = joinRoomResponseSchema.parse(
    (await join({ inviteCode: created.inviteCode, joinKey: keyOpen })).body,
  );
  expect(
    (await join({ inviteCode: created.inviteCode, joinKey: keyExcluded }))
      .status,
  ).toBe(200);
  expect(
    (await join({ inviteCode: created.inviteCode, joinKey: keyLocked })).status,
  ).toBe(200);
  expect((await state(created.roomId))?.joinKeys ?? []).toHaveLength(3);

  const host = await hostSocket(created);
  const rotated1 = await post(
    `/api/rooms/${created.roomId}/invite-code`,
    undefined,
    created.hostToken,
  );
  expect(rotated1.status).toBe(200);
  const firstRotation = regenerateInviteCodeResponseSchema.parse(
    await rotated1.json(),
  );
  expect(firstRotation.inviteCodeVersion).toBe(1);
  expect(await host.next("room:updated")).toMatchObject({
    room: {
      inviteCode: firstRotation.inviteCode,
      inviteCodeVersion: 1,
    },
  });
  expect((await state(created.roomId))?.joinKeys ?? []).toEqual([]);

  // 開放房：帶舊碼時期的鍵走一般新加入，配到新的成員。
  const again = joinRoomResponseSchema.parse(
    (await join({ inviteCode: firstRotation.inviteCode, joinKey: keyOpen }))
      .body,
  );
  expect(again.memberId === first.memberId).toBe(false);
  expect(again.memberToken === first.memberToken).toBe(false);

  // 排除名單：帶舊碼時期的鍵不可繞過 excludeRoomIds。
  expect(
    (
      await join({
        inviteCode: firstRotation.inviteCode,
        joinKey: keyExcluded,
        excludeRoomIds: [created.roomId],
      })
    ).status,
  ).toBe(404);

  // 鎖房後：帶舊碼時期的鍵不可繞過鎖房。
  host.send({ type: "room:update", locked: true, reqId: "lock" });
  expect(await host.next("ack")).toMatchObject({ reqId: "lock", ok: true });
  expect(
    (await join({ inviteCode: firstRotation.inviteCode, joinKey: keyLocked }))
      .status,
  ).toBe(404);

  // 既有成員仍可用原憑證沿用原席位回房。
  const reused = await post(
    joinPath,
    {
      inviteCode: firstRotation.inviteCode,
      nickname: "原成員",
      existingRoomId: created.roomId,
    },
    first.memberToken,
  );
  expect(reused.status).toBe(200);
  expect(await reused.json()).toEqual({
    roomId: created.roomId,
    memberId: first.memberId,
    reused: true,
  });

  // 再次換碼：版本遞增為 2，房主重新連線的 snapshot 也帶著版本 2。
  const rotated2 = await post(
    `/api/rooms/${created.roomId}/invite-code`,
    undefined,
    created.hostToken,
  );
  expect(rotated2.status).toBe(200);
  const secondRotation = regenerateInviteCodeResponseSchema.parse(
    await rotated2.json(),
  );
  expect(secondRotation.inviteCodeVersion).toBe(2);
  host.close();

  const reconnected = await connect(created.roomId);
  reconnected.auth(created.hostToken);
  expect(await reconnected.next("room:snapshot")).toMatchObject({
    room: {
      inviteCode: secondRotation.inviteCode,
      inviteCodeVersion: 2,
    },
  });
  reconnected.close();
});

test("鍵格式錯誤回 400；沿用請求忽略鍵", async () => {
  const { roomId, inviteCode, hostToken, memberId } = await room();
  expectErrorResponse(
    await join({ inviteCode, joinKey: "short" }),
    400,
    "BAD_REQUEST",
  );
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
  expect(saved.includes(joinKey)).toBe(false);
  expect(saved.includes(joined.memberToken)).toBe(false);
  const other = joinRoomResponseSchema.parse(
    (await join({ inviteCode: b.inviteCode, joinKey })).body,
  );
  expect(other.memberToken === joined.memberToken).toBe(false);
  expect(other.roomId).toBe(b.roomId);
});
