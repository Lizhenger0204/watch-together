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
import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { workersServices } from "../src/runtime/workers/services";

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

describe("WHIP / WHEP", () => {
  const route = createApp(workersServices);
  const credentials = {
    REALTIME_APP_ID: "test-app",
    REALTIME_APP_TOKEN: "private-realtime-credential",
  };
  const endpoint = "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions";
  const sdp = (direction: string) =>
    [
      "v=0",
      "o=- 1 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:0",
      `a=${direction}`,
      "",
    ].join("\r\n");
  const publishOffer = sdp("sendonly");
  const subscribeOffer = sdp("recvonly");

  afterEach(() => vi.unstubAllGlobals());

  function request(
    path: string,
    token?: string,
    body?: string,
    options: {
      bindings?: Partial<typeof credentials>;
      contentType?: string;
    } = {},
  ) {
    return route.request(
      `${BASE}${path}`,
      {
        method: body === undefined ? "DELETE" : "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined
            ? { "Content-Type": options.contentType ?? "application/sdp" }
            : {}),
        },
        body,
      },
      { ...env, ...(options.bindings ?? credentials) },
    );
  }

  function mockRealtime(...responses: Response[]) {
    const mock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Realtime request");
      return response;
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  test("驗證成員與房主角色、SDP 格式及必要憑證", async () => {
    const room = await createRoom();
    const viewer = await joinRoom(room.inviteCode);
    const base = `/api/rooms/${room.roomId}`;
    const upstream = mockRealtime();
    expect(
      (await request(`${base}/whip`, undefined, publishOffer)).status,
    ).toBe(401);
    expect(
      (await request(`${base}/whip`, viewer.memberToken, publishOffer)).status,
    ).toBe(403);
    for (const [path, token, body] of [
      [`${base}/whip`, room.hostToken, publishOffer],
      [`${base}/whep`, viewer.memberToken, subscribeOffer],
      [`${base}/relay/unused`, viewer.memberToken, undefined],
    ] as const) {
      for (const missing of [
        "REALTIME_APP_ID",
        "REALTIME_APP_TOKEN",
      ] as const) {
        const response = await request(path, token, body, {
          bindings: { ...credentials, [missing]: undefined },
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: "RELAY_UNAVAILABLE" },
        });
      }
    }
    for (const [body, contentType] of [
      [publishOffer, "text/plain"],
      ["v=0\ninvalid", "application/sdp"],
    ]) {
      const response = await request(`${base}/whip`, room.hostToken, body, {
        contentType,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "BAD_REQUEST" },
      });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  test("開播及發布後才允許訂閱，只有資源建立者能關閉 track", async () => {
    const room = await createRoom();
    const viewer = await joinRoom(room.inviteCode);
    const host = await connect(room.roomId);
    host.auth(room.hostToken);
    await host.next("room:snapshot");
    const base = `/api/rooms/${room.roomId}`;
    const subscribe = () =>
      request(`${base}/whep`, viewer.memberToken, subscribeOffer);
    const tracksResponse = (mid: string, sdp: string) =>
      Response.json({
        tracks: [{ mid, trackName: "media-0" }],
        sessionDescription: { type: "answer", sdp },
      });
    const upstream = mockRealtime(
      Response.json({ sessionId: "publisher" }),
      tracksResponse("0", subscribeOffer),
      Response.json({ sessionId: "subscriber" }),
      tracksResponse("0", publishOffer),
      Response.json({ tracks: [{ mid: "0", errorCode: "internal_error" }] }),
      Response.json({ tracks: [{ mid: "0", errorCode: "close_track_error" }] }),
      Response.json({ tracks: [{ mid: "0" }] }),
    );
    try {
      const before = await subscribe();
      expect(before.status).toBe(409);
      expect(await before.json()).toMatchObject({
        error: { code: "STREAM_NOT_LIVE" },
      });

      const published = await request(
        `${base}/whip`,
        room.hostToken,
        publishOffer,
      );
      expect(published.status).toBe(201);
      expect(published.headers.get("Content-Type")).toBe("application/sdp");
      expect(new TextDecoder().decode(await published.arrayBuffer())).toBe(
        subscribeOffer,
      );
      const publishLocation = published.headers.get("Location")!;
      expect(publishLocation).toMatch(new RegExp(`^${base}/relay/[\\w-]+$`));
      expect(publishLocation).not.toContain("publisher");
      expect((await subscribe()).status).toBe(409);
      expect(upstream).toHaveBeenCalledTimes(2);

      host.send({
        type: "stream:status",
        reqId: "live",
        live: true,
        title: null,
      });
      expect(await host.next("ack")).toMatchObject({ reqId: "live", ok: true });

      const subscribed = await subscribe();
      expect(subscribed.status).toBe(201);
      expect(subscribed.headers.get("Content-Type")).toBe("application/sdp");
      expect(new TextDecoder().decode(await subscribed.arrayBuffer())).toBe(
        publishOffer,
      );
      const subscribeLocation = subscribed.headers.get("Location")!;
      expect(subscribeLocation).toMatch(new RegExp(`^${base}/relay/[\\w-]+$`));
      expect(subscribeLocation).not.toBe(publishLocation);

      expect((await request(subscribeLocation, room.hostToken)).status).toBe(
        403,
      );
      expect((await request(publishLocation, viewer.memberToken)).status).toBe(
        403,
      );
      expect(
        (await request(subscribeLocation, viewer.memberToken)).status,
      ).toBe(503);
      expect(
        (await request(subscribeLocation, viewer.memberToken)).status,
      ).toBe(200);
      expect((await request(publishLocation, room.hostToken)).status).toBe(200);
      expect((await subscribe()).status).toBe(409);

      expect(
        upstream.mock.calls.map(([url, init]) => ({
          url,
          method: init?.method,
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        })),
      ).toEqual([
        { url: `${endpoint}/new`, method: "POST" },
        {
          url: `${endpoint}/publisher/tracks/new`,
          method: "POST",
          body: {
            sessionDescription: { type: "offer", sdp: publishOffer },
            tracks: [{ location: "local", mid: "0", trackName: "media-0" }],
          },
        },
        { url: `${endpoint}/new`, method: "POST" },
        {
          url: `${endpoint}/subscriber/tracks/new`,
          method: "POST",
          body: {
            sessionDescription: { type: "offer", sdp: subscribeOffer },
            tracks: [
              {
                location: "remote",
                sessionId: "publisher",
                trackName: "media-0",
              },
            ],
          },
        },
        {
          url: `${endpoint}/subscriber/tracks/close`,
          method: "PUT",
          body: { force: true, tracks: [{ mid: "0" }] },
        },
        {
          url: `${endpoint}/subscriber/tracks/close`,
          method: "PUT",
          body: { force: true, tracks: [{ mid: "0" }] },
        },
        {
          url: `${endpoint}/publisher/tracks/close`,
          method: "PUT",
          body: { force: true, tracks: [{ mid: "0" }] },
        },
      ]);
      for (const [, init] of upstream.mock.calls) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${credentials.REALTIME_APP_TOKEN}`,
        );
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
    } finally {
      host.close();
    }
  });

  test("上游回傳錯誤時只公開通用錯誤", async () => {
    const room = await createRoom();
    const upstream = mockRealtime(
      Response.json(
        {
          errorDescription: credentials.REALTIME_APP_TOKEN,
          other: room.hostToken,
        },
        { status: 502 },
      ),
    );
    const failed = await request(
      `/api/rooms/${room.roomId}/whip`,
      room.hostToken,
      publishOffer,
    );
    expect(failed.status).toBe(503);
    expect(failed.headers.has("Location")).toBe(false);
    const body = await failed.text();
    expect(JSON.parse(body)).toMatchObject({
      error: { code: "RELAY_UNAVAILABLE" },
    });
    expect(body).not.toContain(credentials.REALTIME_APP_TOKEN);
    expect(body).not.toContain(room.hostToken);
    expect(upstream).toHaveBeenCalledOnce();
  });
});
