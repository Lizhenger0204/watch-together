import { WS_HEARTBEAT_TIMEOUT_MS } from "@project/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { RoomState } from "../src/room/room";
import type { Env } from "../src/runtime/workers/env";
import type { RoomDO } from "../src/runtime/workers/room-do";
import {
  REALTIME,
  publishOffer,
  request,
  subscribeOffer,
} from "./relay-fixture";
import {
  alarmTime,
  connect,
  createRoom,
  hostSocket,
  joinRoom,
  runAlarmAt,
  setMode,
} from "./room-fixture";

const HOST_OFFLINE_TTL_MS = 100_000;
const IDLE_TTL_MS = 100_000;

async function at<T>(now: number, work: () => Promise<T>) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    return await work();
  } finally {
    clock.mockRestore();
  }
}

async function pingMember(
  stub: DurableObjectStub<RoomDO>,
  memberId: string,
  now: number,
) {
  await at(now, () =>
    runInDurableObject(stub, async (instance, state) => {
      const ws = state
        .getWebSockets()
        .find(
          (socket) => socket.deserializeAttachment()?.memberId === memberId,
        )!;
      await instance.webSocketMessage(ws, JSON.stringify({ type: "ping" }));
    }),
  );
}

async function disconnectHost(
  room: Awaited<ReturnType<typeof createRoom>>,
  now: number,
) {
  return at(now, () =>
    runInDurableObject(
      env.ROOM.getByName(room.roomId),
      async (instance, state) => {
        const ws = state
          .getWebSockets()
          .find(
            (socket) =>
              socket.deserializeAttachment()?.memberId === room.memberId,
          )!;
        await instance.webSocketClose(ws, 1000);
      },
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("房主斷線且房內仍有在線收看者：100 秒後僅移除房主並保留房間，全員離線滿 100 秒才關房", async () => {
  const t0 = Date.now();
  const room = await at(t0, () => createRoom());
  const host = await at(t0, () => hostSocket(room));
  const member = await at(t0, () => joinRoom(room.inviteCode, "小明"));
  const viewer = await at(t0, async () => {
    const socket = await connect(room.roomId);
    socket.auth(member.memberToken);
    await socket.next("room:snapshot");
    return socket;
  });
  await host.next("room:members");

  host.send({
    type: "stream:status",
    live: true,
    title: "電影",
    reqId: "live",
  });
  expect(await host.next("ack")).toMatchObject({ ok: true });
  expect(await viewer.next("stream:status")).toMatchObject({ live: true });

  const stub = env.ROOM.getByName(room.roomId);
  const goneAt = t0 + 5_000;
  await disconnectHost(room, goneAt);
  expect(await viewer.next("room:members")).toMatchObject({
    members: [
      { memberId: room.memberId, online: false },
      { memberId: member.memberId, online: true },
    ],
  });
  expect(await viewer.next("stream:status")).toMatchObject({ live: false });

  // 收看者正常心跳維持在線
  await pingMember(stub, member.memberId, goneAt + 50_000);
  await viewer.next("pong");

  // 未滿 100 秒：房主與邀請碼都還在
  await runAlarmAt(stub, goneAt + HOST_OFFLINE_TTL_MS - 1);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: true });

  // 滿 100 秒：僅移除房主，收看者留在房內且可繼續聊天
  await pingMember(stub, member.memberId, goneAt + 95_000);
  await viewer.next("pong");
  await runAlarmAt(stub, goneAt + HOST_OFFLINE_TTL_MS);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: false });
  expect(await stub.authenticate(member.memberToken)).toMatchObject({
    ok: true,
  });
  expect(
    await env.INVITE_DIRECTORY.getByName("global").lookup(room.inviteCode),
  ).toBe(room.roomId);
  expect(await viewer.next("room:members")).toEqual({
    type: "room:members",
    members: [
      {
        memberId: member.memberId,
        nickname: "小明",
        role: "member",
        online: true,
      },
    ],
  });
  viewer.send({ type: "chat:send", reqId: "c1", text: "房主走了我們繼續聊" });
  expect(await viewer.next("ack")).toMatchObject({ reqId: "c1", ok: true });
  expect(await viewer.next("chat:message")).toMatchObject({
    memberId: member.memberId,
    text: "房主走了我們繼續聊",
  });

  // 最後一位收看者離線後，再滿 100 秒才釋放房間、邀請碼與完整 storage
  const viewerGoneAt = goneAt + HOST_OFFLINE_TTL_MS + 1_000;
  await at(viewerGoneAt, () =>
    runInDurableObject(stub, async (instance, state) => {
      const ws = state
        .getWebSockets()
        .find(
          (socket) =>
            socket.deserializeAttachment()?.memberId === member.memberId,
        )!;
      await instance.webSocketClose(ws, 1000);
    }),
  );
  await runAlarmAt(stub, viewerGoneAt + IDLE_TTL_MS);
  expect(await stub.authenticate(member.memberToken)).toMatchObject({
    ok: false,
  });
  expect(
    await env.INVITE_DIRECTORY.getByName("global").lookup(room.inviteCode),
  ).toBeNull();
  const left = await runInDurableObject(stub, async (_i, state) => ({
    size: (await state.storage.list()).size,
    alarm: await state.storage.getAlarm(),
  }));
  expect(left).toEqual({ size: 0, alarm: null });
  host.close();
  viewer.close();
});

test("只有房主或全體收看者均已離線：房主離線滿 100 秒移除房主並立即釋放空房", async () => {
  const room = await createRoom();
  const host = await hostSocket(room);
  const viewer = await joinRoom(room.inviteCode);
  const socket = await connect(room.roomId);
  socket.auth(viewer.memberToken);
  await socket.next("room:snapshot");

  const stub = env.ROOM.getByName(room.roomId);
  const viewerGoneAt = Date.now();
  await at(viewerGoneAt, () =>
    runInDurableObject(stub, async (instance, state) => {
      const ws = state
        .getWebSockets()
        .find(
          (item) => item.deserializeAttachment()?.memberId === viewer.memberId,
        )!;
      await instance.webSocketClose(ws, 1000);
    }),
  );

  const hostGoneAt = viewerGoneAt + 5_000;
  await disconnectHost(room, hostGoneAt);
  await runAlarmAt(stub, hostGoneAt + HOST_OFFLINE_TTL_MS);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: false });
  expect(await stub.authenticate(viewer.memberToken)).toMatchObject({
    ok: false,
  });
  expect(
    await env.INVITE_DIRECTORY.getByName("global").lookup(room.inviteCode),
  ).toBeNull();
  const left = await runInDurableObject(stub, async (_i, state) => ({
    size: (await state.storage.list()).size,
    alarm: await state.storage.getAlarm(),
  }));
  expect(left).toEqual({ size: 0, alarm: null });
  host.close();
  socket.close();
});

test("建房後從未驗證 WebSocket，也在 100 秒房主寬限期限移除並釋放空房", async () => {
  const room = await createRoom();
  const stub = env.ROOM.getByName(room.roomId);
  const createdAt = await runInDurableObject(
    stub,
    async (_instance, state) =>
      (await state.storage.get<RoomState>("state"))!.createdAt,
  );
  expect(await alarmTime(stub)).toBe(createdAt + HOST_OFFLINE_TTL_MS);
  await runAlarmAt(stub, createdAt + HOST_OFFLINE_TTL_MS);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: false });
  expect(
    await env.INVITE_DIRECTORY.getByName("global").lookup(room.inviteCode),
  ).toBeNull();
});

test("房主 100 秒寬限內驗證成功，舊期限 alarm 不能移除房主或關房", async () => {
  const room = await createRoom();
  const host = await hostSocket(room);
  const stub = env.ROOM.getByName(room.roomId);
  const goneAt = Date.now();
  await disconnectHost(room, goneAt);
  const replacement = await at(goneAt + HOST_OFFLINE_TTL_MS - 1_000, () =>
    hostSocket(room),
  );
  await runAlarmAt(stub, goneAt + HOST_OFFLINE_TTL_MS);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: true });
  replacement.send({ type: "ping" });
  expect(await replacement.next("pong")).toEqual({ type: "pong" });
  host.close();
  replacement.close();
});

test("跨分頁以 4000 取代後，舊連線晚到的 close 不會啟動房主移除期限", async () => {
  const room = await createRoom();
  const host = await hostSocket(room);
  const stub = env.ROOM.getByName(room.roomId);
  const old = await runInDurableObject(
    stub,
    (_instance, state) => state.getWebSockets()[0]!,
  );
  const replacedAt = Date.now();
  const replacement = await at(replacedAt, () => hostSocket(room));
  expect(await host.closedWith()).toBe(4000);
  await at(replacedAt + 500, () =>
    runInDurableObject(stub, (instance) => instance.webSocketClose(old, 4000)),
  );
  // 新連線保持正常心跳
  await pingMember(stub, room.memberId, replacedAt + 50_000);
  expect(await replacement.next("pong")).toEqual({ type: "pong" });
  await runAlarmAt(stub, replacedAt + HOST_OFFLINE_TTL_MS);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: true });
  replacement.send({ type: "ping" });
  expect(await replacement.next("pong")).toEqual({ type: "pong" });
  replacement.close();
});

test("房主 WebSocket 沒有 close frame：60 秒心跳逾時以 4410 斷線並顯示離線，100 秒後移除房主", async () => {
  const t0 = Date.now() + 1_000;
  const room = await at(t0, () => createRoom());
  const viewer = await at(t0, () => joinRoom(room.inviteCode));
  const viewerSocket = await at(t0, async () => {
    const socket = await connect(room.roomId);
    socket.auth(viewer.memberToken);
    await socket.next("room:snapshot");
    return socket;
  });

  const host = await at(t0, () => hostSocket(room));
  await viewerSocket.next("room:members");
  const stub = env.ROOM.getByName(room.roomId);

  // 第 30 秒房主送 ping、第 40 秒收看者送 ping：第 60 秒兩者都不會被踢
  await pingMember(stub, room.memberId, t0 + 30_000);
  expect(await host.next("pong")).toEqual({ type: "pong" });
  await pingMember(stub, viewer.memberId, t0 + 40_000);
  expect(await viewerSocket.next("pong")).toEqual({ type: "pong" });

  await runAlarmAt(stub, t0 + WS_HEARTBEAT_TIMEOUT_MS);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: true });

  // 維持收看者活動
  await pingMember(stub, viewer.memberId, t0 + 80_000);
  await viewerSocket.next("pong");

  // 最後活動 t0+30s 起算滿 60 秒（t0+90s）：心跳逾時以 4410 關閉，房主離線起算 t0+30s
  await runAlarmAt(stub, t0 + 30_000 + WS_HEARTBEAT_TIMEOUT_MS);
  expect(await host.closedWith()).toBe(4410);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: true });
  expect(await viewerSocket.next("room:members")).toMatchObject({
    members: expect.arrayContaining([
      expect.objectContaining({ memberId: room.memberId, online: false }),
    ]),
  });
  const saved = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<{ hostDisconnectedAt: number | null }>("state"),
  );
  expect(saved?.hostDisconnectedAt).toBe(t0 + 30_000);

  // 維持收看者活動，直到從 t0+30s 起算滿 100 秒（t0+130s）房主被移除
  await pingMember(stub, viewer.memberId, t0 + 120_000);
  await viewerSocket.next("pong");
  await runAlarmAt(stub, t0 + 30_000 + HOST_OFFLINE_TTL_MS);
  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: false });
  expect(await viewerSocket.next("room:members")).toEqual({
    type: "room:members",
    members: [
      {
        memberId: viewer.memberId,
        nickname: "朋友",
        role: "member",
        online: true,
      },
    ],
  });
  viewerSocket.close();
});

test("轉發模式下房主離線滿 100 秒被移除（房內仍有收看者）：撤下 WHIP 發布與綁定訂閱", async () => {
  const t0 = Date.now();
  const room = await at(t0, () => createRoom());
  const viewer = await at(t0, () => joinRoom(room.inviteCode));
  const host = await at(t0, () => hostSocket(room));
  const stub = env.ROOM.getByName(room.roomId);
  await runInDurableObject(stub, (instance) => {
    const runtime = instance as unknown as { env: Env };
    runtime.env = { ...runtime.env, ...REALTIME };
  });
  let serial = 0;
  const closed: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/sessions/new")) {
        return Response.json({ sessionId: `session-${++serial}` });
      }
      const body = JSON.parse(String(init?.body)) as {
        tracks: { mid?: string; trackName?: string }[];
      };
      const session = path.split("/").at(-3)!;
      if (path.endsWith("/tracks/close")) {
        closed.push(session);
        return Response.json({ tracks: body.tracks });
      }
      if (!path.endsWith("/tracks/new")) throw new Error("非預期的測試請求");
      return Response.json({
        tracks: [{ mid: session, trackName: body.tracks[0]?.trackName }],
        sessionDescription: { type: "answer", sdp: subscribeOffer },
      });
    }),
  );

  await setMode(host, "relay");
  const whip = await request(
    `/api/rooms/${room.roomId}/whip`,
    room.hostToken,
    publishOffer,
  );
  expect(whip.status).toBe(201);
  host.send({
    type: "stream:status",
    live: true,
    title: "電影",
    reqId: "live",
  });
  expect(await host.next("ack")).toMatchObject({ ok: true });

  const viewerSocket = await at(t0, async () => {
    const socket = await connect(room.roomId);
    socket.auth(viewer.memberToken);
    await socket.next("room:snapshot");
    return socket;
  });
  const whep = await request(
    `/api/rooms/${room.roomId}/whep`,
    viewer.memberToken,
    subscribeOffer,
  );
  expect(whep.status).toBe(201);

  const goneAt = t0 + 1_000;
  await disconnectHost(room, goneAt);
  await pingMember(stub, viewer.memberId, goneAt + 50_000);
  await viewerSocket.next("pong");
  await runAlarmAt(stub, goneAt + HOST_OFFLINE_TTL_MS);

  expect(await stub.authenticate(room.hostToken)).toMatchObject({ ok: false });
  expect(await stub.getRelayPublication()).toBeNull();
  await vi.waitFor(() =>
    expect(closed.sort()).toEqual(["session-1", "session-2"]),
  );
  host.close();
  viewerSocket.close();
});
