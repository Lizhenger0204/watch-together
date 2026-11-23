import {
  PROTOCOL_VERSION,
  createRoomResponseSchema,
  iceResponseSchema,
  joinRoomResponseSchema,
  parseServerMessage,
  type ServerMessage,
} from "@project/shared";
import {
  SELF,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";

const BASE = "https://signal.test";

function post(path: string, body?: unknown, token?: string) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.0.0.${Math.floor(Math.random() * 250)}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createRoom() {
  const res = await post("/api/rooms", { nickname: "房主" });
  expect(res.status).toBe(201);
  return createRoomResponseSchema.parse(await res.json());
}

async function joinRoom(inviteCode: string, nickname = "朋友") {
  const res = await post("/api/rooms/join", { inviteCode, nickname });
  expect(res.status).toBe(200);
  return joinRoomResponseSchema.parse(await res.json());
}

/** 開 WebSocket，收集伺服器訊息，提供 next(type) 等待特定訊息。 */
async function connect(roomId: string) {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`沒有 WebSocket（status ${res.status}）`);
  ws.accept();

  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  let closed: { code: number } | null = null;
  ws.addEventListener("message", (event) => {
    const parsed = parseServerMessage(event.data as string);
    if (!parsed.ok) throw new Error(parsed.error);
    inbox.push(parsed.message);
    waiters.splice(0).forEach((wake) => wake());
  });
  ws.addEventListener("close", (event) => {
    closed = { code: event.code };
    waiters.splice(0).forEach((wake) => wake());
  });

  async function next<T extends ServerMessage["type"]>(type: T) {
    for (;;) {
      const index = inbox.findIndex((m) => m.type === type);
      if (index >= 0) {
        return inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
      }
      if (closed)
        throw new Error(`連線已關閉（${closed.code}），沒有收到 ${type}`);
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }
  async function closedWith() {
    while (!closed) await new Promise<void>((resolve) => waiters.push(resolve));
    return closed.code;
  }

  return {
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    auth: (token: string) =>
      ws.send(
        JSON.stringify({
          type: "auth",
          token,
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    next,
    closedWith,
    close: () => ws.close(1000),
  };
}

describe("REST", () => {
  test("建房 → 加入；邀請碼不分大小寫、可帶連字號", async () => {
    const room = await createRoom();
    const lower =
      `${room.inviteCode.slice(0, 4)}-${room.inviteCode.slice(4)}`.toLowerCase();
    const joined = await joinRoom(lower);
    expect(joined.roomId).toBe(room.roomId);
  });

  test("錯誤的邀請碼與格式錯誤的邀請碼都回 404 ROOM_NOT_FOUND", async () => {
    for (const inviteCode of ["ZZZZZZZZ", "not-a-code"]) {
      const res = await post("/api/rooms/join", { inviteCode, nickname: "x" });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { code: "ROOM_NOT_FOUND" },
      });
    }
  });

  test("暱稱空白回 400", async () => {
    const res = await post("/api/rooms", { nickname: "   " });
    expect(res.status).toBe(400);
  });

  test("重新產生邀請碼：只有房主可以，舊碼立即失效", async () => {
    const room = await createRoom();
    const member = await joinRoom(room.inviteCode);

    const forbidden = await post(
      `/api/rooms/${room.roomId}/invite-code`,
      undefined,
      member.memberToken,
    );
    expect(forbidden.status).toBe(403);

    const res = await post(
      `/api/rooms/${room.roomId}/invite-code`,
      undefined,
      room.hostToken,
    );
    expect(res.status).toBe(200);
    const { inviteCode } = (await res.json()) as { inviteCode: string };
    expect(inviteCode).not.toBe(room.inviteCode);

    expect(
      (
        await post("/api/rooms/join", {
          inviteCode: room.inviteCode,
          nickname: "x",
        })
      ).status,
    ).toBe(404);
    expect((await joinRoom(inviteCode)).roomId).toBe(room.roomId);
  });

  test("ICE：需要成員 token，回傳 STUN", async () => {
    const room = await createRoom();
    const url = `${BASE}/api/rooms/${room.roomId}/ice`;
    expect((await SELF.fetch(url)).status).toBe(401);
    const res = await SELF.fetch(url, {
      headers: { Authorization: `Bearer ${room.hostToken}` },
    });
    expect(res.status).toBe(200);
    const { iceServers } = iceResponseSchema.parse(await res.json());
    expect(JSON.stringify(iceServers)).toContain(
      "stun:stun.cloudflare.com:3478",
    );
  });

  test("WebSocket 端點：不是 upgrade 回 426，roomId 格式錯誤回 404", async () => {
    const room = await createRoom();
    expect(
      (await SELF.fetch(`${BASE}/api/rooms/${room.roomId}/ws`)).status,
    ).toBe(426);
    const bad = await SELF.fetch(`${BASE}/api/rooms/not-a-uuid/ws`, {
      headers: { Upgrade: "websocket" },
    });
    expect(bad.status).toBe(404);
  });
});

describe("WebSocket", () => {
  test("驗證、快照、信令轉送、狀態回報", async () => {
    const room = await createRoom();
    const member = await joinRoom(room.inviteCode, "小明");

    const host = await connect(room.roomId);
    host.auth(room.hostToken);
    const hostSnapshot = await host.next("room:snapshot");
    expect(hostSnapshot.you.role).toBe("host");
    expect(hostSnapshot.room.inviteCode).toBe(room.inviteCode);

    const viewer = await connect(room.roomId);
    viewer.auth(member.memberToken);
    const viewerSnapshot = await viewer.next("room:snapshot");
    expect(viewerSnapshot.room).not.toHaveProperty("inviteCode");
    expect(
      viewerSnapshot.members.find((m) => m.memberId === member.memberId)
        ?.online,
    ).toBe(true);

    const members = await host.next("room:members");
    expect(members.members.map((m) => m.nickname)).toContain("小明");

    // 開播 → 收看者收到 stream:status，房主收到 peer:request
    host.send({
      type: "stream:status",
      reqId: "s1",
      live: true,
      title: "電影",
    });
    expect(await host.next("ack")).toMatchObject({ reqId: "s1", ok: true });
    expect(await viewer.next("stream:status")).toMatchObject({
      live: true,
      title: "電影",
    });
    expect(await host.next("peer:request")).toEqual({
      type: "peer:request",
      memberId: member.memberId,
    });

    // 信令雙向轉送
    host.send({
      type: "signal",
      to: member.memberId,
      data: { type: "offer", sdp: "v=0 offer" },
    });
    expect(await viewer.next("signal")).toEqual({
      type: "signal",
      from: room.memberId,
      data: { type: "offer", sdp: "v=0 offer" },
    });
    viewer.send({
      type: "signal",
      to: room.memberId,
      data: { type: "answer", sdp: "v=0 answer" },
    });
    expect((await host.next("signal")).data).toEqual({
      type: "answer",
      sdp: "v=0 answer",
    });

    // 收看者狀態只轉給房主
    viewer.send({ type: "member:status", state: "playing", bitrateKbps: 5000 });
    expect(await host.next("member:status")).toMatchObject({
      memberId: member.memberId,
      status: { state: "playing", bitrateKbps: 5000 },
    });

    // 房主斷線 → 收看者看到直播中止
    host.close();
    expect(await viewer.next("stream:status")).toMatchObject({ live: false });
    viewer.close();
  });

  test("錯誤的 token 會被關閉（4401）", async () => {
    const room = await createRoom();
    const ws = await connect(room.roomId);
    ws.auth("x".repeat(43));
    expect(await ws.next("error")).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await ws.closedWith()).toBe(4401);
  });

  test("未驗證就送其他訊息會被關閉（4400）", async () => {
    const room = await createRoom();
    const ws = await connect(room.roomId);
    ws.send({ type: "ping" });
    expect(await ws.closedWith()).toBe(4400);
  });

  test("被踢的成員：連線被關閉，舊 token 不能再用", async () => {
    const room = await createRoom();
    const member = await joinRoom(room.inviteCode);

    const host = await connect(room.roomId);
    host.auth(room.hostToken);
    await host.next("room:snapshot");
    const viewer = await connect(room.roomId);
    viewer.auth(member.memberToken);
    await viewer.next("room:snapshot");

    host.send({ type: "room:kick", reqId: "k", memberId: member.memberId });
    expect(await viewer.next("room:closed")).toEqual({
      type: "room:closed",
      reason: "kicked",
    });
    expect(await viewer.closedWith()).toBe(4003);

    const again = await connect(room.roomId);
    again.auth(member.memberToken);
    expect(await again.closedWith()).toBe(4401);
    host.close();
  });

  test("同一成員開第二條連線，舊連線被取代（4000）", async () => {
    const room = await createRoom();
    const first = await connect(room.roomId);
    first.auth(room.hostToken);
    await first.next("room:snapshot");
    const second = await connect(room.roomId);
    second.auth(room.hostToken);
    await second.next("room:snapshot");
    expect(await first.closedWith()).toBe(4000);
    second.close();
  });
});

describe("限流與生命週期", () => {
  test("同一 IP 加入超過每分鐘 10 次回 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await SELF.fetch(`${BASE}/api/rooms/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.9",
        },
        body: JSON.stringify({ inviteCode: "ZZZZZZZZ", nickname: "x" }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test("到期時 alarm 關閉房間：連線收到 room:closed，邀請碼失效", async () => {
    const room = await createRoom();
    const host = await connect(room.roomId);
    host.auth(room.hostToken);
    await host.next("room:snapshot");

    const stub = env.ROOM.getByName(room.roomId);
    await runInDurableObject(stub, (instance) => {
      // 把建房時間往前推，讓房間超過最長存活時間
      const target = instance as unknown as { room: { createdAt: number } };
      target.room.createdAt = 0;
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await host.next("room:closed")).toEqual({
      type: "room:closed",
      reason: "expired",
    });
    expect(await host.closedWith()).toBe(4001);
    const res = await post("/api/rooms/join", {
      inviteCode: room.inviteCode,
      nickname: "x",
    });
    expect(res.status).toBe(404);
  });
});
