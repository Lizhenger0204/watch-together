import { PROTOCOL_VERSION } from "@project/shared";
import { describe, expect, test, vi } from "vitest";
import { SignalClient, SignalDisconnectedError } from "./signal";
import {
  FakeSocket,
  fakeTimers,
  flushMicrotasks,
  setup,
  snapshot,
} from "./signal.fixtures";

describe("SignalClient resync 與前景心跳", () => {
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
      {
        type: "auth",
        token: "secret-token",
        protocolVersion: PROTOCOL_VERSION,
      },
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

  test("背景分頁切回前景時立即補送一次 ping，stop 後解除監聽", () => {
    const doc = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
    };
    doc.visibilityState = "hidden";
    vi.stubGlobal("document", doc);
    try {
      const { client, current } = setup();
      current().open();
      current().receive(snapshot);
      current().sent.length = 0;

      doc.dispatchEvent(new Event("visibilitychange"));
      expect(current().sent).toEqual([]);

      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(current().sent).toEqual([{ type: "ping" }]);

      client.stop();
      current().sent.length = 0;
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(current().sent).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
