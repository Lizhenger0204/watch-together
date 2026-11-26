import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../src/runtime/workers/env";
import {
  REALTIME,
  publishOffer,
  request,
  subscribeOffer,
} from "./relay-fixture";
import {
  BASE,
  connect,
  createRoom,
  hostSocket,
  joinRoom,
  post,
  setMode,
} from "./room-fixture";

const leave = (roomId: string, token?: string) =>
  post(`/api/rooms/${roomId}/leave`, undefined, token);

const ice = (roomId: string, token: string) =>
  SELF.fetch(`${BASE}/api/rooms/${roomId}/ice`, {
    headers: { Authorization: `Bearer ${token}` },
  });

describe("明確退房", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("離房會一併撤銷加入冪等結果，重送原 joinKey 只會配發新的身份", async () => {
    const room = await createRoom();
    const body = {
      inviteCode: room.inviteCode,
      nickname: "朋友",
      joinKey: "J".repeat(43),
    };
    const joined = (await (await post("/api/rooms/join", body)).json()) as {
      memberId: string;
      memberToken: string;
    };
    expect((await leave(room.roomId, joined.memberToken)).status).toBe(204);
    const replay = await post("/api/rooms/join", body);
    expect(replay.status).toBe(200);
    const next = (await replay.json()) as typeof joined;
    expect(next.memberId !== joined.memberId).toBe(true);
    expect(next.memberToken !== joined.memberToken).toBe(true);
    expect((await ice(room.roomId, joined.memberToken)).status).toBe(401);
    expect((await ice(room.roomId, next.memberToken)).status).toBe(200);
  });

  test("移除席位提交失敗時，原身份與名單維持原狀，重試才成功", async () => {
    const room = await createRoom();
    const viewer = await joinRoom(room.inviteCode);
    const stub = env.ROOM.getByName(room.roomId);
    await runInDurableObject(stub, (_instance, state) => {
      vi.spyOn(state.storage, "transaction").mockRejectedValueOnce(
        new Error("storage unavailable"),
      );
    });
    expect((await leave(room.roomId, viewer.memberToken)).status).toBe(500);
    expect((await ice(room.roomId, viewer.memberToken)).status).toBe(200);
    const socket = await connect(room.roomId);
    socket.auth(viewer.memberToken);
    try {
      expect((await socket.next("room:snapshot")).members).toHaveLength(2);
      expect((await leave(room.roomId, viewer.memberToken)).status).toBe(204);
      expect((await ice(room.roomId, viewer.memberToken)).status).toBe(401);
    } finally {
      socket.close();
    }
  });

  test("收看者離房立即撤銷憑證並從房主名單移除，可以重新加入", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);
    const viewer = await joinRoom(room.inviteCode);
    const socket = await connect(room.roomId);
    socket.auth(viewer.memberToken);
    await socket.next("room:snapshot");
    await host.next("room:members");
    try {
      const response = await leave(room.roomId, viewer.memberToken);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect((await ice(room.roomId, viewer.memberToken)).status).toBe(401);
      const changed = await host.next("room:members");
      expect(changed.members.map((member) => member.memberId)).toEqual([
        room.memberId,
      ]);
      expect(await socket.closedWith()).toBe(4401);
      expect((await ice(room.roomId, room.hostToken)).status).toBe(200);
      expect((await joinRoom(room.inviteCode)).memberId).not.toBe(
        viewer.memberId,
      );
    } finally {
      host.close();
      socket.close();
    }
  });

  test("房主獨自在房離房即關房、釋放邀請碼與完整 storage，不等閒置期限", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);
    expect((await leave(room.roomId, room.hostToken)).status).toBe(204);
    expect(await host.closedWith()).toBe(4001);
    expect((await ice(room.roomId, room.hostToken)).status).toBe(401);
    expect(
      await env.INVITE_DIRECTORY.getByName("global").lookup(room.inviteCode),
    ).toBeNull();
    const remaining = await runInDurableObject(
      env.ROOM.getByName(room.roomId),
      async (_instance, state) => ({
        size: (await state.storage.list()).size,
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(remaining).toEqual({ size: 0, alarm: null });
    expect(
      (
        await post("/api/rooms/join", {
          inviteCode: room.inviteCode,
          nickname: "新人",
        })
      ).status,
    ).toBe(404);
  });

  test("房主在仍有收看者在線時離房：僅移除房主並保留房間，最後一位收看者也離房才立即釋放", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);
    const viewer = await joinRoom(room.inviteCode);
    const socket = await connect(room.roomId);
    socket.auth(viewer.memberToken);
    await socket.next("room:snapshot");
    await host.next("room:members");

    host.send({
      type: "stream:status",
      live: true,
      title: "電影",
      reqId: "live",
    });
    expect(await host.next("ack")).toMatchObject({ ok: true });
    expect(await socket.next("stream:status")).toMatchObject({ live: true });

    expect((await leave(room.roomId, room.hostToken)).status).toBe(204);
    expect(await host.closedWith()).toBe(4401);
    expect((await ice(room.roomId, room.hostToken)).status).toBe(401);
    expect((await ice(room.roomId, viewer.memberToken)).status).toBe(200);
    expect(
      await env.INVITE_DIRECTORY.getByName("global").lookup(room.inviteCode),
    ).toBe(room.roomId);

    const changed = await socket.next("room:members");
    expect(changed.members).toEqual([
      {
        memberId: viewer.memberId,
        nickname: "朋友",
        role: "member",
        online: true,
      },
    ]);
    expect(await socket.next("stream:status")).toMatchObject({ live: false });

    // 收看者仍可在房內繼續聊天
    socket.send({ type: "chat:send", reqId: "c1", text: "房主先走了" });
    expect(await socket.next("ack")).toMatchObject({ reqId: "c1", ok: true });
    expect(await socket.next("chat:message")).toMatchObject({
      memberId: viewer.memberId,
      text: "房主先走了",
    });

    // 最後一位收看者離房：立即關房、釋放邀請碼與完整 storage
    expect((await leave(room.roomId, viewer.memberToken)).status).toBe(204);
    expect(await socket.closedWith()).toBe(4001);
    expect((await ice(room.roomId, viewer.memberToken)).status).toBe(401);
    expect(
      await env.INVITE_DIRECTORY.getByName("global").lookup(room.inviteCode),
    ).toBeNull();
    const remaining = await runInDurableObject(
      env.ROOM.getByName(room.roomId),
      async (_instance, state) => ({
        size: (await state.storage.list()).size,
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(remaining).toEqual({ size: 0, alarm: null });
    expect(
      (
        await post("/api/rooms/join", {
          inviteCode: room.inviteCode,
          nickname: "新人",
        })
      ).status,
    ).toBe(404);
  });

  test("轉發模式下房主在有收看者時離房：撤下 WHIP 發布與綁定訂閱", async () => {
    const room = await createRoom();
    const viewer = await joinRoom(room.inviteCode);
    const host = await hostSocket(room);
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
    expect(
      (
        await request(
          `/api/rooms/${room.roomId}/whip`,
          room.hostToken,
          publishOffer,
        )
      ).status,
    ).toBe(201);
    host.send({
      type: "stream:status",
      live: true,
      title: "電影",
      reqId: "live",
    });
    expect(await host.next("ack")).toMatchObject({ ok: true });

    const viewerSocket = await connect(room.roomId);
    viewerSocket.auth(viewer.memberToken);
    await viewerSocket.next("room:snapshot");
    expect(
      (
        await request(
          `/api/rooms/${room.roomId}/whep`,
          viewer.memberToken,
          subscribeOffer,
        )
      ).status,
    ).toBe(201);

    expect((await leave(room.roomId, room.hostToken)).status).toBe(204);
    expect(await stub.getRelayPublication()).toBeNull();
    await vi.waitFor(() =>
      expect(closed.sort()).toEqual(["session-1", "session-2"]),
    );
    viewerSocket.close();
  });

  test("無認證或其他房間的憑證不能退房；重試被撤銷的憑證為 401", async () => {
    const room = await createRoom();
    const other = await createRoom();
    expect((await leave(room.roomId)).status).toBe(401);
    expect((await leave(room.roomId, other.hostToken)).status).toBe(401);
    expect((await ice(room.roomId, room.hostToken)).status).toBe(200);
    const viewer = await joinRoom(room.inviteCode);
    expect((await leave(room.roomId, viewer.memberToken)).status).toBe(204);
    expect((await leave(room.roomId, viewer.memberToken)).status).toBe(401);
    expect((await ice(room.roomId, room.hostToken)).status).toBe(200);
  });

  test("房主退房後最後一位收看者立刻斷線，不因房主關閉中連線而漏排 100 秒空房計時", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);
    const viewer = await joinRoom(room.inviteCode);
    const viewerSocket = await connect(room.roomId);
    viewerSocket.auth(viewer.memberToken);
    await viewerSocket.next("room:snapshot");
    await host.next("room:members");

    expect((await leave(room.roomId, room.hostToken)).status).toBe(204);
    await viewerSocket.next("room:members");

    const stub = env.ROOM.getByName(room.roomId);
    const beforeClose = Date.now();
    await runInDurableObject(stub, async (instance, state) => {
      const ws = state
        .getWebSockets()
        .find(
          (sock) => sock.deserializeAttachment()?.memberId === viewer.memberId,
        )!;
      await instance.webSocketClose(ws, 1000);
    });
    const saved = await runInDurableObject(stub, async (_i, state) => ({
      room: await state.storage.get<{ idleSince: number | null }>("state"),
      alarm: await state.storage.getAlarm(),
    }));
    expect(saved.room?.idleSince).not.toBeNull();
    expect(saved.alarm).toBeGreaterThanOrEqual(beforeClose + 100_000);
    expect(saved.alarm).toBeLessThanOrEqual(Date.now() + 101_000);
    host.close();
    viewerSocket.close();
  });

  test("換碼進行中房主退房：依 lifecycle 序列化執行，不會拋出 500 也不留孤兒邀請碼", async () => {
    const room = await createRoom();
    const stub = env.ROOM.getByName(room.roomId);
    let onEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      onEntered = resolve;
    });
    let onResume!: () => void;
    const resume = new Promise<void>((resolve) => {
      onResume = resolve;
    });

    const outcome = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as {
        directory: () => {
          replace: (
            oldCode: string,
            roomId: string,
            opId: string,
          ) => Promise<string>;
          release: (code: string, roomId: string) => Promise<void>;
        };
      };
      const real = target.directory.bind(instance);
      let rotatedCode = "";
      target.directory = () => ({
        release: (code, id) => real().release(code, id),
        replace: async (oldCode, roomId, opId) => {
          onEntered();
          await resume;
          rotatedCode = await real().replace(oldCode, roomId, opId);
          return rotatedCode;
        },
      });
      const rotation = instance.regenerateInviteCode(room.memberId);
      await entered;
      const leaving = instance.leave(room.memberId);
      onResume();
      const [rotated, left] = await Promise.all([rotation, leaving]);
      target.directory = real;
      return { rotated, left, rotatedCode };
    });

    expect(outcome.rotated.ok).toBe(true);
    expect(outcome.left.ok).toBe(true);
    const directory = env.INVITE_DIRECTORY.getByName("global");
    expect(await directory.lookup(room.inviteCode)).toBeNull();
    expect(await directory.lookup(outcome.rotatedCode)).toBeNull();
  });
});
