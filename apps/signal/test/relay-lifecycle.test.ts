import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { RoomState } from "../src/room/room";
import type { Env } from "../src/runtime/workers/env";
import {
  alarmTime,
  connect,
  createRoom,
  deferred,
  hostSocket,
  joinRoom,
  runAlarmAt,
  setMode,
} from "./room-fixture";
import {
  publishOffer,
  REALTIME,
  request,
  subscribeOffer,
} from "./relay-fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const room = await createRoom();
  const viewer = await joinRoom(room.inviteCode);
  const host = await hostSocket(room);
  const stub = env.ROOM.getByName(room.roomId);
  await runInDurableObject(stub, (instance) => {
    const runtime = instance as unknown as { env: Env };
    runtime.env = { ...runtime.env, ...REALTIME };
  });
  const closed: string[] = [];
  const closeEvents = new EventTarget();
  async function untilClosed(...sessions: string[]) {
    await Promise.all(
      sessions
        .filter((id) => !closed.includes(id))
        .map(
          (id) =>
            new Promise<void>((resolve) => {
              closeEvents.addEventListener(id, () => resolve(), { once: true });
            }),
        ),
    );
  }
  const sources: string[] = [];
  let serial = 0;
  const sfu = {
    failClose: false,
    renegotiate: false,
    partialFailure: false,
    beforeAnswer: async () => {},
  };
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/sessions/new")) {
      return Response.json({ sessionId: `session-${++serial}` });
    }
    const body = JSON.parse(String(init?.body)) as {
      tracks: { mid?: string; trackName?: string; sessionId?: string }[];
      force?: boolean;
    };
    const session = path.split("/").at(-3)!;
    if (path.endsWith("/tracks/close")) {
      expect(body).toEqual({ tracks: [{ mid: session }], force: true });
      closed.push(session);
      closeEvents.dispatchEvent(new Event(session));
      return sfu.failClose
        ? new Response(null, { status: 503 })
        : Response.json({ tracks: body.tracks });
    }
    if (!path.endsWith("/tracks/new")) throw new Error("非預期的測試請求");
    if (body.tracks[0]?.sessionId) sources.push(body.tracks[0].sessionId);
    await sfu.beforeAnswer();
    return Response.json({
      tracks: [
        { mid: session, trackName: body.tracks[0]?.trackName },
        ...(sfu.partialFailure ? [{ errorCode: "failed_track" }] : []),
      ],
      requiresImmediateRenegotiation: sfu.renegotiate,
      sessionDescription: { type: "answer", sdp: subscribeOffer },
    });
  });
  vi.stubGlobal("fetch", upstream);
  const path = `/api/rooms/${room.roomId}`;
  const publish = () => request(`${path}/whip`, room.hostToken, publishOffer);
  const subscribe = (token = viewer.memberToken) =>
    request(`${path}/whep`, token, subscribeOffer);
  async function live() {
    await setMode(host, "relay");
    expect((await publish()).status).toBe(201);
    host.send({
      type: "stream:status",
      live: true,
      title: null,
      reqId: "live",
    });
    expect(await host.next("ack")).toMatchObject({ ok: true, reqId: "live" });
  }
  return {
    room,
    viewer,
    host,
    stub,
    sfu,
    closed,
    untilClosed,
    sources,
    upstream,
    publish,
    subscribe,
    live,
  };
}

test("P2P 房間的 WHIP、WHEP 都回 409，切換 relay 才會呼叫 SFU", async () => {
  const { publish, subscribe, upstream, live } = await setup();
  for (const [post, message] of [
    [publish, "請先切換到轉發模式再發布"],
    [subscribe, "目前沒有可收看的轉發直播"],
  ] as const) {
    const res = await post();
    expect(upstream).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "STREAM_NOT_LIVE", message },
    });
  }
  await live();
  expect((await subscribe()).status).toBe(201);
});

test("踢人關閉該成員全部 WHEP，其他成員仍能訂閱；舊 token 再送 WHEP 回 401", async () => {
  const {
    room,
    viewer,
    host,
    stub,
    subscribe,
    live,
    closed,
    untilClosed,
    upstream,
  } = await setup();
  await live();
  const other = await joinRoom(room.inviteCode);
  const locations = [];
  for (const token of [
    viewer.memberToken,
    other.memberToken,
    viewer.memberToken,
  ]) {
    const response = await subscribe(token);
    expect(response.status).toBe(201);
    if (token === viewer.memberToken)
      locations.push(response.headers.get("Location")!.split("/").at(-1)!);
  }
  host.send({ type: "room:kick", memberId: viewer.memberId, reqId: "kick" });
  await host.next("ack");
  expect(
    (await host.next("room:members")).members.map((m) => m.memberId),
  ).not.toContain(viewer.memberId);
  const openedSessions = () =>
    upstream.mock.calls.filter(([url]) => String(url).endsWith("/sessions/new"))
      .length;
  const calls = openedSessions();
  const denied = await subscribe();
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({
    error: { code: "UNAUTHORIZED" },
  });
  expect(openedSessions()).toBe(calls);
  expect((await subscribe(other.memberToken)).status).toBe(201);
  for (const id of locations)
    expect(await stub.getRelayResource(id)).toBeNull();
  await untilClosed("session-2", "session-4");
  expect(closed.sort()).toEqual(["session-2", "session-4"]);
});

test("自行離線會關 WHEP 並保留席位，之後加入觸發淘汰時也關閉剩餘訂閱", async () => {
  const { room, viewer, host, live, subscribe, stub, closed, untilClosed } =
    await setup();
  await live();
  const socket = await connect(room.roomId);
  socket.auth(viewer.memberToken);
  await socket.next("room:snapshot");
  await host.next("room:members");
  expect((await subscribe()).status).toBe(201);
  socket.close();
  expect((await host.next("room:members")).members).toContainEqual(
    expect.objectContaining({ memberId: viewer.memberId, online: false }),
  );
  expect((await subscribe()).status).toBe(201);
  await untilClosed("session-2");
  expect(closed).toEqual(["session-2"]);
  await runInDurableObject(stub, (instance) => {
    const { room: state } = instance as unknown as { room: RoomState };
    state.members.find((m) => m.memberId === viewer.memberId)!.lastSeenAt = 0;
  });
  await joinRoom(room.inviteCode);
  await untilClosed("session-2", "session-3");
  expect(closed).toEqual(["session-2", "session-3"]);
  expect((await subscribe()).status).toBe(401);
});

test("替換發布會關舊發布與舊訂閱，關閉失敗由 alarm 重試且保留新發布", async () => {
  const {
    live,
    publish,
    subscribe,
    closed,
    untilClosed,
    sfu,
    stub,
    sources,
    viewer,
  } = await setup();
  await live();
  const oldSubscription = await subscribe();
  expect(oldSubscription.status).toBe(201);
  sfu.failClose = true;
  expect((await publish()).status).toBe(201);
  expect(
    (
      await request(
        oldSubscription.headers.get("Location")!,
        viewer.memberToken,
      )
    ).status,
  ).toBe(403);
  await untilClosed("session-1", "session-2");
  expect(closed.sort()).toEqual(["session-1", "session-2"]);
  sfu.failClose = false;
  await runAlarmAt(stub, (await alarmTime(stub))!);
  expect(closed.sort()).toEqual([
    "session-1",
    "session-1",
    "session-2",
    "session-2",
  ]);
  expect((await subscribe()).status).toBe(201);
  expect(sources).toEqual(["session-1", "session-3"]);
});

test("切回 P2P 會撤下全部資源，切回 relay 前的未完成 WHIP 在登記時回 409", async () => {
  const { live, host, publish, subscribe, closed, untilClosed, sfu } =
    await setup();
  await live();
  expect((await subscribe()).status).toBe(201);
  const started = deferred();
  const resume = deferred();
  sfu.beforeAnswer = async () => {
    started.resolve();
    await resume.promise;
  };
  const posting = publish();
  await started.promise;
  try {
    await setMode(host, "p2p");
  } finally {
    resume.resolve();
  }
  const rejected = await posting;
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({
    error: {
      code: "STREAM_NOT_LIVE",
      message: "房間狀態已變更，請確認轉發狀態後重試",
    },
  });
  await untilClosed("session-1", "session-2", "session-3");
  expect(closed.sort()).toEqual(["session-1", "session-2", "session-3"]);
  await setMode(host, "relay");
  expect((await subscribe()).status).toBe(409);
});

test.each([false, true])(
  "上游要求額外協商且關閉失敗時回通用 503，由 alarm 關閉已知 tracks（其他 track 失敗 %s）",
  async (partialFailure) => {
    const { live, subscribe, closed, sfu, stub } = await setup();
    await live();
    sfu.renegotiate = true;
    sfu.partialFailure = partialFailure;
    sfu.failClose = true;
    const failed = await subscribe();
    expect(failed.status).toBe(503);
    expect(failed.headers.has("Location")).toBe(false);
    expect(await failed.json()).toEqual({
      error: { code: "RELAY_UNAVAILABLE", message: "轉發模式目前無法使用" },
    });
    expect(closed).toEqual(["session-2"]);
    const next = await alarmTime(stub);
    expect(next).toBeLessThanOrEqual(Date.now() + 30_000);
    sfu.failClose = false;
    await runAlarmAt(stub, next!);
    expect(closed).toEqual(["session-2", "session-2"]);
  },
);

test("舊 WHIP 在切回 relay 且新發布已就緒後才收到 answer，會回滾舊 tracks", async () => {
  const { live, host, publish, subscribe, sfu, closed, untilClosed, sources } =
    await setup();
  await live();
  const started = deferred();
  const resume = deferred();
  sfu.beforeAnswer = async () => {
    started.resolve();
    await resume.promise;
  };
  const late = publish();
  await started.promise;
  try {
    await setMode(host, "p2p");
    await setMode(host, "relay");
    sfu.beforeAnswer = async () => {};
    expect((await publish()).status).toBe(201);
  } finally {
    resume.resolve();
  }
  expect((await late).status).toBe(409);
  expect((await subscribe()).status).toBe(201);
  expect(sources).toEqual(["session-3"]);
  await untilClosed("session-1", "session-2");
  expect(closed.sort()).toEqual(["session-1", "session-2"]);
});

test("離開時仍在協商的 WHEP 會回滾；被新連線取代保留訂閱", async () => {
  const { live, room, viewer, subscribe, sfu, closed, untilClosed, host } =
    await setup();
  await live();
  const first = await connect(room.roomId);
  first.auth(viewer.memberToken);
  await first.next("room:snapshot");
  await host.next("room:members");
  expect((await subscribe()).status).toBe(201);
  const second = await connect(room.roomId);
  second.auth(viewer.memberToken);
  await second.next("room:snapshot");
  await host.next("room:members");
  expect(await first.closedWith()).toBe(4000);
  expect(closed).toEqual([]);
  const started = deferred();
  const resume = deferred();
  sfu.beforeAnswer = async () => {
    started.resolve();
    await resume.promise;
  };
  const late = subscribe();
  await started.promise;
  try {
    second.close();
    await host.next("room:members");
  } finally {
    resume.resolve();
  }
  expect((await late).status).toBe(409);
  await untilClosed("session-2", "session-3");
  expect(closed.sort()).toEqual(["session-2", "session-3"]);
});

test("踢人與清理排程同筆交易，排 alarm 失敗後席位及 WHEP 都可重新處理", async () => {
  const { live, stub, subscribe, viewer, closed, untilClosed, host, sfu } =
    await setup();
  await live();
  const response = await subscribe();
  expect(response.status).toBe(201);
  const id = response.headers.get("Location")!.split("/").at(-1)!;
  const kick = { type: "room:kick", memberId: viewer.memberId, reqId: "kick" };
  await runInDurableObject(stub, async (instance, state) => {
    const transact = state.storage.transaction.bind(state.storage);
    const fault = vi
      .spyOn(state.storage, "transaction")
      .mockImplementationOnce((work) =>
        transact(async (txn) => {
          vi.spyOn(txn, "setAlarm").mockRejectedValueOnce(
            new Error("無法排 alarm"),
          );
          return work(txn);
        }),
      );
    try {
      await expect(
        instance.webSocketMessage(
          state.getWebSockets()[0]!,
          JSON.stringify(kick),
        ),
      ).rejects.toThrow("無法排 alarm");
    } finally {
      fault.mockRestore();
    }
    expect((await instance.authenticate(viewer.memberToken)).ok).toBe(true);
    expect((await instance.getRelayResource(id))?.ownerId).toBe(
      viewer.memberId,
    );
  });
  expect(closed).toEqual([]);
  sfu.failClose = true;
  host.send(kick);
  expect(await host.next("ack")).toMatchObject({ ok: true, reqId: "kick" });
  expect((await subscribe()).status).toBe(401);
  await untilClosed("session-2");
  expect(closed).toEqual(["session-2"]);
  sfu.failClose = false;
  const at = await alarmTime(stub);
  expect(at).toBeLessThanOrEqual(Date.now() + 30_000);
  await runAlarmAt(stub, at!);
  expect(closed).toEqual(["session-2", "session-2"]);
});

test("踢人期間尚在協商的 WHEP 不能登記，並行加入的席位也都保留", async () => {
  const { live, room, host, stub, subscribe, viewer, sfu, closed } =
    await setup();
  await live();
  const started = deferred();
  const resume = deferred();
  sfu.beforeAnswer = async () => {
    started.resolve();
    await resume.promise;
  };
  const pending = subscribe();
  await started.promise;
  let joined;
  try {
    host.send({ type: "room:kick", memberId: viewer.memberId, reqId: "kick" });
    joined = await Promise.all(
      Array.from({ length: 5 }, () => joinRoom(room.inviteCode)),
    );
    expect(await host.next("ack")).toMatchObject({ reqId: "kick", ok: true });
  } finally {
    resume.resolve();
  }
  expect((await pending).status).toBe(403);
  expect(closed).toEqual(["session-2"]);
  expect((await subscribe()).status).toBe(401);
  for (const member of joined) {
    expect(await stub.authenticate(member.memberToken)).toMatchObject({
      ok: true,
      value: { memberId: member.memberId },
    });
  }
});
