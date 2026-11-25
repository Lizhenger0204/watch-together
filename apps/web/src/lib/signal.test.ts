import { DEFAULT_QUALITY } from "@project/shared";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "./api";
import {
  IDENTITY_CHECK_AFTER_ATTEMPTS,
  SignalClient,
  SignalDisconnectedError,
  SignalTimeoutError,
  type SignalClientOptions,
  type SocketLike,
  type Timers,
} from "./signal";

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
    quality: DEFAULT_QUALITY,
    createdAt: 0,
  },
  members: [],
  stream: { live: false, title: null, startedAt: null },
  you: { memberId: "m", role: "host" },
};

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(options: Partial<SignalClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const { timers, advance } = fakeTimers();
  const client = new SignalClient({
    url: "ws://test",
    token: "secret-token",
    timers,
    random: () => 1,
    ...options,
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
    // 斷線造成的失敗要能和伺服器拒絕區分（房主換片途中斷線不可取消開播意圖）
    await expect(pending).rejects.toBeInstanceOf(SignalDisconnectedError);
  });

  test("未連上就送 request 也是連線中斷；伺服器拒絕則不是", async () => {
    const offline = setup();
    await expect(
      offline.client.request({ type: "room:update", locked: true }),
    ).rejects.toBeInstanceOf(SignalDisconnectedError);

    const { client, current, connect } = setup();
    connect();
    const bad = client.request({ type: "room:kick", memberId: "x" });
    const [ask] = current().sent.slice(1) as { reqId: string }[];
    current().receive({
      type: "ack",
      reqId: ask!.reqId,
      ok: false,
      code: "FORBIDDEN",
    });
    const error = await bad.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SignalDisconnectedError);
  });

  test("stop 後不再重連", () => {
    const { client, sockets, connect, advance, states } = setup();
    connect();
    client.stop();
    advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe("closed:stopped");
  });

  test("ack 逆序回來時仍依 reqId 配對", async () => {
    const { client, current, connect } = setup();
    connect();
    const first = client.request({ type: "room:update", locked: true });
    const second = client.request({ type: "room:kick", memberId: "x" });
    const [a, b] = current().sent.slice(1) as { reqId: string }[];
    current().receive({
      type: "ack",
      reqId: b!.reqId,
      ok: false,
      code: "FORBIDDEN",
    });
    current().receive({ type: "ack", reqId: a!.reqId, ok: true });
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toEqual(new ApiError("FORBIDDEN"));
  });

  test("4408 之後重連並重新 auth", () => {
    const { sockets, current, connect, advance, states } = setup();
    connect();
    current().drop(4408);
    advance(1000);
    expect(sockets).toHaveLength(2);
    current().open();
    expect(current().sent[0]).toMatchObject({ type: "auth" });
    current().receive(snapshot);
    expect(states.at(-1)).toBe("open");
  });

  test.each([
    ["room_closed", "closed:room_closed"],
    ["unauthorized", "closed:unauthorized"],
  ] as const)(
    "連續重連失敗 %i 次且一直沒收到 snapshot：用 REST 確認身份，%s 就停止重連",
    async (result, state) => {
      const verifyIdentity = vi.fn(async () => result);
      const { sockets, current, advance, states } = setup({ verifyIdentity });
      for (let i = 1; i < IDENTITY_CHECK_AFTER_ATTEMPTS; i++) {
        current().drop(1006);
        advance(15_000);
      }
      expect(verifyIdentity).not.toHaveBeenCalled();
      current().drop(1006);
      expect(verifyIdentity).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(states.at(-1)).toBe(state);
      const count = sockets.length;
      advance(60_000);
      expect(sockets).toHaveLength(count);
    },
  );

  test("確認身份仍有效（真的是網路問題）就繼續退避重連", async () => {
    const verifyIdentity = vi.fn(async () => "valid" as const);
    const { sockets, current, advance, states } = setup({ verifyIdentity });
    for (let i = 0; i < IDENTITY_CHECK_AFTER_ATTEMPTS; i++) {
      current().drop(1006);
      advance(15_000);
    }
    await Promise.resolve();
    expect(verifyIdentity).toHaveBeenCalledTimes(1);
    const count = sockets.length;
    current().drop(1006);
    expect(states.at(-1)).toBe("reconnecting");
    advance(15_000);
    expect(sockets).toHaveLength(count + 1);
  });

  test("確認身份途中連上了：忽略結果", async () => {
    let resolve: (v: "unauthorized") => void = () => {};
    const verifyIdentity = vi.fn(
      () => new Promise<"unauthorized">((r) => (resolve = r)),
    );
    const { current, advance, states } = setup({ verifyIdentity });
    for (let i = 0; i < IDENTITY_CHECK_AFTER_ATTEMPTS; i++) {
      current().drop(1006);
      advance(15_000);
    }
    current().open();
    current().receive(snapshot);
    const closed = states.length;
    resolve("unauthorized");
    // 等 verify().catch().then() 整條鏈跑完再斷言，否則還沒處理就先通過。
    await flushMicrotasks();
    expect(verifyIdentity).toHaveBeenCalledTimes(1);
    expect(states.slice(closed)).toEqual([]);
    expect(states.at(-1)).toBe("open");
  });

  test("驗證前就收到 4400：確認身份，token 已無效就當成 4401", async () => {
    const verifyIdentity = vi.fn(async () => "unauthorized" as const);
    const { current, states } = setup({ verifyIdentity });
    current().open();
    current().drop(4400);
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toBe("closed:unauthorized");
  });

  test("驗證前就收到 4400 但身份有效（協定版本不符）：維持要求重新整理", async () => {
    const verifyIdentity = vi.fn(async () => "valid" as const);
    const { current, states } = setup({ verifyIdentity });
    current().open();
    current().drop(4400);
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toBe("closed:bad_request");
  });

  test("驗證後才收到 4400：不查身份，直接要求重新整理", () => {
    const verifyIdentity = vi.fn(async () => "unauthorized" as const);
    const { current, connect, states } = setup({ verifyIdentity });
    connect();
    current().drop(4400);
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("closed:bad_request");
  });

  test("request 逾時以 SignalTimeoutError 拒絕；伺服器回 ack ok:false（含 INTERNAL）則是一般 ApiError", async () => {
    const { client, current, connect, advance } = setup({
      requestTimeoutMs: 5_000,
    });
    connect();

    const timedOutReq = client.request({ type: "room:update", mode: "relay" });
    advance(4_999);
    const rejectedReq = client.request({ type: "room:update", locked: true });
    const [, second] = current().sent.slice(1) as { reqId: string }[];
    current().receive({
      type: "ack",
      reqId: second!.reqId,
      ok: false,
      code: "INTERNAL",
    });
    advance(1);

    const timeoutErr = await timedOutReq.catch((e: unknown) => e);
    expect(timeoutErr).toBeInstanceOf(SignalTimeoutError);
    expect(timeoutErr).toBeInstanceOf(ApiError);
    expect(timeoutErr).not.toBeInstanceOf(SignalDisconnectedError);
    expect((timeoutErr as ApiError).code).toBe("INTERNAL");

    const rejectedErr = await rejectedReq.catch((e: unknown) => e);
    expect(rejectedErr).toBeInstanceOf(ApiError);
    expect(rejectedErr).not.toBeInstanceOf(SignalTimeoutError);
    expect(rejectedErr).not.toBeInstanceOf(SignalDisconnectedError);
    expect((rejectedErr as ApiError).code).toBe("INTERNAL");
  });

  test("resync 關閉現有 socket、取消在途請求、忽略舊 socket 晚到訊息與關閉，並立刻重連重新 auth", async () => {
    const { client, sockets, current, connect, advance, states } = setup();
    const received: unknown[] = [];
    client.onMessage((message) => received.push(message));
    connect();
    received.length = 0;

    const oldSocket = current();
    const pending = client.request({ type: "room:update", mode: "relay" });

    client.resync();

    expect(oldSocket.close).toHaveBeenCalledWith(1000, "resync");
    await expect(pending).rejects.toBeInstanceOf(SignalDisconnectedError);
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");

    // 舊 socket 晚到的訊息與終止關閉碼都必須被忽略。
    oldSocket.receive({
      type: "room:updated",
      room: { ...snapshot.room, mode: "relay" },
    });
    oldSocket.drop(4000);
    oldSocket.drop(1006);
    expect(received).toEqual([]);
    expect(states.at(-1)).toBe("connecting");
    expect(sockets).toHaveLength(2);

    // 新連線送 auth 並收到最新 snapshot。
    const nextSocket = current();
    nextSocket.open();
    expect(nextSocket.sent).toEqual([
      { type: "auth", token: "secret-token", protocolVersion: 1 },
    ]);
    const nextSnapshot = {
      ...snapshot,
      room: { ...snapshot.room, mode: "relay" as const },
    };
    nextSocket.receive(nextSnapshot);
    expect(states.at(-1)).toBe("open");
    expect(received).toEqual([nextSnapshot]);

    // 舊請求的逾時計時器與舊心跳不會再觸發副作用。
    advance(20_000);
    expect(
      oldSocket.sent.filter((m) => (m as { type: string }).type === "ping"),
    ).toHaveLength(0);
    expect(
      nextSocket.sent.filter((m) => (m as { type: string }).type === "ping"),
    ).toHaveLength(1);
  });

  test("resync 時舊 socket 若在 close() 內同步觸發 onclose，不排程重連也不干擾新連線", () => {
    const { client, sockets, current, connect, advance, states } = setup();
    connect();
    const oldSocket = current();
    oldSocket.close.mockImplementation(() => {
      oldSocket.drop(1000);
    });

    client.resync();

    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");
    advance(60_000);
    expect(sockets).toHaveLength(2);
  });

  test("resync 在退避重連期間呼叫：取消舊計時器、歸零退避次數並立刻開新連線", () => {
    const { client, sockets, current, connect, advance, states } = setup();
    connect();
    current().drop(1006);
    advance(1000); // 第 1 次重連
    current().drop(1006); // 第 2 次退避（2 秒）進行中
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toBe("reconnecting");

    client.resync();
    expect(sockets).toHaveLength(3);
    expect(states.at(-1)).toBe("connecting");

    // 推進原本的 2 秒退避時間，不會被舊計時器多開一條 socket。
    advance(5_000);
    expect(sockets).toHaveLength(3);

    // 新連線若再斷線，退避次數已歸零（第 1 次為 1 秒，不是 4 秒）。
    current().drop(1006);
    advance(999);
    expect(sockets).toHaveLength(3);
    advance(1);
    expect(sockets).toHaveLength(4);
  });

  test.each([
    [4000, "replaced"],
    [4001, "room_closed"],
    [4003, "kicked"],
    [4400, "bad_request"],
    [4401, "unauthorized"],
  ])("關閉碼 %i（%s）結束後呼叫 resync 不做任何事", (code, reason) => {
    const { client, sockets, current, connect, states } = setup();
    connect();
    current().drop(code);
    const beforeStates = [...states];

    client.resync();

    expect(sockets).toHaveLength(1);
    expect(states).toEqual(beforeStates);
    expect(states.at(-1)).toBe(`closed:${reason}`);
  });

  test("stop() 後呼叫 resync 不做任何事", () => {
    const { client, sockets, connect, states } = setup();
    connect();
    client.stop();
    const beforeStates = [...states];

    client.resync();

    expect(sockets).toHaveLength(1);
    expect(states).toEqual(beforeStates);
    expect(states.at(-1)).toBe("closed:stopped");
  });

  test("首次 start() 前呼叫 resync 不建立連線；之後 start() 最多只有一條有效連線", () => {
    const sockets: FakeSocket[] = [];
    const { timers } = fakeTimers();
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
    client.resync();
    expect(sockets).toHaveLength(0);

    client.start();
    expect(sockets).toHaveLength(1);
    // 已啟動時重複呼叫 start() 不應再開第二條 socket。
    client.start();
    expect(sockets).toHaveLength(1);
  });

  test("舊連線驗證前 4400 的 verifyIdentity 結果晚到，不可終止 resync() 建立的新連線", async () => {
    const resolvers: Array<(v: "valid" | "unauthorized") => void> = [];
    const verifyIdentity = vi.fn(
      () => new Promise<"valid" | "unauthorized">((r) => resolvers.push(r)),
    );
    const { client, sockets, current, states } = setup({ verifyIdentity });

    // 舊連線在驗證前收到 4400，身份查詢進行中。
    current().open();
    current().drop(4400);
    expect(verifyIdentity).toHaveBeenCalledTimes(1);

    // 主動 resync() 建立新連線。
    client.resync();
    expect(sockets).toHaveLength(2);
    const nextSocket = current();
    expect(states.at(-1)).toBe("connecting");

    // 舊查詢在新 snapshot 抵達前完成：必須被忽略，不可關掉新連線。
    resolvers[0]!("valid");
    await flushMicrotasks();
    expect(nextSocket.close).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("connecting");

    // 新連線自己若在驗證前遇到 4400，仍會依終止關閉碼處理。
    nextSocket.open();
    nextSocket.drop(4400);
    expect(verifyIdentity).toHaveBeenCalledTimes(2);
    resolvers[1]!("valid");
    await flushMicrotasks();
    expect(states.at(-1)).toBe("closed:bad_request");
  });
});
