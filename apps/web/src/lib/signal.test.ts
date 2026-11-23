import { describe, expect, test, vi } from "vitest";
import { ApiError } from "./api";
import { SignalClient, type SocketLike, type Timers } from "./signal";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close = vi.fn();
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<
    number,
    { at: number; fn: () => void; every?: number }
  >();
  const timers: Timers = {
    setTimeout: (fn, ms) => (tasks.set(nextId, { at: now + ms, fn }), nextId++),
    clearTimeout: (id) => tasks.delete(id as number),
    setInterval: (fn, ms) => (
      tasks.set(nextId, { at: now + ms, fn, every: ms }),
      nextId++
    ),
    clearInterval: (id) => tasks.delete(id as number),
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...tasks]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      now = task.at;
      if (task.every) task.at += task.every;
      else tasks.delete(id);
      task.fn();
    }
    now = end;
  }
  return { timers, advance };
}

const snapshot = {
  type: "room:snapshot",
  room: {
    roomId: "r",
    locked: false,
    mode: "p2p",
    quality: "standard",
    createdAt: 0,
  },
  members: [],
  stream: { live: false, title: null, startedAt: null },
  you: { memberId: "m", role: "host" },
};

function setup() {
  const sockets: FakeSocket[] = [];
  const { timers, advance } = fakeTimers();
  const client = new SignalClient({
    url: "ws://test",
    token: "secret-token",
    timers,
    random: () => 1,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const states: string[] = [];
  client.onState((s) =>
    states.push(s.status === "closed" ? `closed:${s.reason}` : s.status),
  );
  client.start();
  const current = () => sockets[sockets.length - 1]!;
  const connect = () => {
    current().open();
    current().receive(snapshot);
  };
  return { client, sockets, current, connect, advance, states };
}

describe("SignalClient", () => {
  test("連線後第一則訊息是 auth，收到 snapshot 才算連上", () => {
    const { current, states } = setup();
    current().open();
    expect(current().sent).toEqual([
      { type: "auth", token: "secret-token", protocolVersion: 1 },
    ]);
    expect(states).toEqual(["connecting"]);
    current().receive(snapshot);
    expect(states).toEqual(["connecting", "open"]);
  });

  test("request 依 reqId 對應 ack：成功 resolve、失敗以 ApiError 拒絕", async () => {
    const { client, current, connect } = setup();
    connect();
    const ok = client.request({ type: "room:update", locked: true });
    const bad = client.request({ type: "room:kick", memberId: "x" });
    const [first, second] = current().sent.slice(1) as { reqId: string }[];
    current().receive({ type: "ack", reqId: first!.reqId, ok: true });
    current().receive({
      type: "ack",
      reqId: second!.reqId,
      ok: false,
      code: "FORBIDDEN",
    });
    await expect(ok).resolves.toBeUndefined();
    await expect(bad).rejects.toEqual(new ApiError("FORBIDDEN"));
  });

  test("未連上時 request 立即失敗，send 回傳 false", async () => {
    const { client } = setup();
    expect(client.send({ type: "ping" })).toBe(false);
    await expect(
      client.request({ type: "room:update", locked: true }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("連上後每 20 秒送 ping", () => {
    const { current, connect, advance } = setup();
    connect();
    advance(40_000);
    expect(
      current().sent.filter((m) => (m as { type: string }).type === "ping"),
    ).toHaveLength(2);
  });

  test.each([
    [4000, "replaced"],
    [4001, "room_closed"],
    [4003, "kicked"],
    [4400, "bad_request"],
    [4401, "unauthorized"],
  ])("關閉碼 %i 不重連（%s）", (code, reason) => {
    const { sockets, current, connect, advance, states } = setup();
    connect();
    current().drop(code);
    advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe(`closed:${reason}`);
  });

  test("其他關閉碼以指數退避重連，連上後次數歸零", () => {
    const { sockets, current, connect, advance, states } = setup();
    connect();
    current().drop(1006);
    expect(states.at(-1)).toBe("reconnecting");
    advance(999);
    expect(sockets).toHaveLength(1);
    advance(1); // 第 1 次：1 秒
    expect(sockets).toHaveLength(2);
    current().drop(1006);
    advance(1999);
    expect(sockets).toHaveLength(2);
    advance(1); // 第 2 次：2 秒
    expect(sockets).toHaveLength(3);
    connect();
    expect(states.at(-1)).toBe("open");
    current().drop(1006);
    advance(1000); // 歸零後又是 1 秒
    expect(sockets).toHaveLength(4);
  });

  test("斷線時尚未回應的 request 會被拒絕", async () => {
    const { client, current, connect } = setup();
    connect();
    const pending = client.request({ type: "room:update", locked: true });
    current().drop(1006);
    await expect(pending).rejects.toBeInstanceOf(ApiError);
  });

  test("stop 後不再重連", () => {
    const { client, sockets, connect, advance, states } = setup();
    connect();
    client.stop();
    advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe("closed:stopped");
  });
});
