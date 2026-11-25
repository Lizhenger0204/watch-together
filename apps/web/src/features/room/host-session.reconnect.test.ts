import type { Mode, ServerMessage } from "@project/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SignalClient, type SocketLike } from "../../lib/signal";
import { HostSession } from "./host-session";
import { MODE_UPDATED_TIMEOUT_MS } from "./host-session-base";
import {
  FakeTransport,
  flush,
  host,
  label,
  readySource,
  roomUpdated,
  setup,
  snapshot,
  viewer,
} from "./host-session.fixtures";

// 房主重新連線、被 4000 取代、傳輸整體失敗與舊代次回呼失效。

describe("房主重新連線", () => {
  test("斷線期間保留傳輸；新的 snapshot 銷毀舊傳輸並重建，start 後才送 live:true", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "reconnecting", attempt: 1 });
    expect(t.log).toEqual([]);
    expect(t.session.getView().phase).toBe("waiting");

    t.connect();
    expect(t.log).toEqual(["destroy", "create p2p", "start"]);
    await flush();
    expect(t.client.requests).toHaveLength(0);
    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.log.at(-1)).toBe("stream:status live 電影");
  });

  test("重新連線時片源還沒就緒（重新整理後）：不重建，片源就緒後才開播", () => {
    const t = setup({ intent: true });
    t.connect();
    t.session.setSource({ stream: null, status: "idle", title: "" });
    expect(t.transports).toHaveLength(0);
    expect(t.session.getView().phase).toBe("waiting");
    t.session.setSource(readySource());
    expect(t.transports).toHaveLength(1);
  });

  test("被 4000 取代：銷毀傳輸，之後不再送任何東西", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "closed", reason: "replaced" });
    expect(t.log).toEqual(["destroy"]);
    t.session.setIntent(false);
    t.session.setSource(readySource(undefined, "別片"));
    t.client.emit(snapshot());
    expect(t.log).toEqual(["destroy"]);
  });

  test("被 4000 取代：舊分頁的開播意圖失效，回來後要手動開播", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "closed", reason: "replaced" });
    expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
    expect(t.session.getView().intent).toBe(false);
    // 不是房主明確停播：不能讓接手的分頁保存的意圖失效。
    expect(t.onExplicitStop).not.toHaveBeenCalled();
  });

  test("其他原因結束連線（離開頁面 stop()）：保留意圖，重新整理後自動恢復", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "closed", reason: "stopped" });
    expect(t.onIntentChange).not.toHaveBeenCalledWith(false);
    expect(t.session.getView().intent).toBe(true);
  });

  test("重新驗證時另一分頁已明確停播：舊意圖失效，不自動開播", async () => {
    let valid = true;
    const t = setup({ intentStillValid: () => valid });
    await t.goLive();
    t.client.state({ status: "reconnecting", attempt: 1 });
    valid = false;
    t.connect();
    expect(t.log).toEqual(["destroy"]);
    expect(t.transports).toHaveLength(1);
    expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toContain("另一個分頁");
    // 手動開播仍可以。
    t.session.setIntent(true);
    expect(t.transports).toHaveLength(2);
  });

  test("明確按停止才通知其他分頁；開播失敗自動取消意圖不算", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.reject(new Error("boom"));
    await flush();
    expect(t.session.getView().intent).toBe(false);
    expect(t.onExplicitStop).not.toHaveBeenCalled();
    t.session.setIntent(true);
    t.session.setIntent(false);
    expect(t.onExplicitStop).toHaveBeenCalledTimes(1);
  });

  test("舊代次的 start() 晚 resolve：不送 live:true", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.connect(); // 重新驗證
    expect(t.log).toEqual([
      "create p2p",
      "start",
      "destroy",
      "create p2p",
      "start",
    ]);
    t.transports[0]!.gate.resolve();
    await flush();
    expect(t.client.requests).toHaveLength(0);
    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.client.requests.map((r) => label(r.message))).toEqual([
      "stream:status live 電影",
    ]);
  });

  test("直播中傳輸整體失敗：拆掉、取消意圖、送停播並顯示錯誤", async () => {
    const t = setup();
    const transport = await t.goLive();
    transport.emitState("error");
    expect(t.log).toEqual(["destroy", "stream:status off"]);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toBeTruthy();
  });

  test("不是房主的 snapshot：什麼都不做", () => {
    const t = setup();
    t.client.state({ status: "open" });
    t.client.emit({
      ...snapshot(),
      you: { memberId: "v1", role: "member" },
    } as ServerMessage);
    t.session.setSource(readySource());
    expect(t.log).toEqual([]);
  });

  test("getView 沒變時回傳同一個物件", async () => {
    const t = setup();
    await t.goLive();
    const before = t.session.getView();
    t.client.emit({ type: "room:members", members: [host, viewer("v1")] });
    expect(t.session.getView()).toBe(before);
  });
});

class MockSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  close = vi.fn();
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function wireSnapshot(mode: Mode) {
  const base = snapshot({ mode }) as Extract<
    ServerMessage,
    { type: "room:snapshot" }
  >;
  return { ...base, room: { ...base.room, inviteCode: undefined } };
}

function setupWithSignalClient(requestTimeoutMs?: number) {
  const sockets: MockSocket[] = [];
  const client = new SignalClient({
    url: "ws://test",
    token: "host-token",
    requestTimeoutMs,
    createSocket: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    timers: {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id as number),
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (id) => globalThis.clearInterval(id as number),
    },
  });
  const log: string[] = [];
  const transports: FakeTransport[] = [];
  const session = new HostSession({
    client,
    roomId: "room",
    token: "host-token",
    initialIntent: true,
    createTransport: (opts) => {
      log.push(`create ${opts.mode}`);
      const transport = new FakeTransport(opts, log);
      transports.push(transport);
      return transport;
    },
  });
  const detach = session.attach();
  client.start();

  const goLiveAndStartSwitch = async () => {
    sockets[0]!.open();
    sockets[0]!.receive(wireSnapshot("p2p"));
    session.setSource(readySource());
    transports[0]!.gate.resolve();
    await flush();
    sockets[0]!.receive({
      type: "ack",
      reqId: sockets[0]!.sent.at(-1)!.reqId,
      ok: true,
    });
    await flush();
    expect(session.getView().phase).toBe("live");

    session.setMode("relay");
    sockets[0]!.receive({
      type: "ack",
      reqId: sockets[0]!.sent.at(-1)!.reqId,
      ok: true,
    });
    await flush();
    expect(sockets[0]!.sent.at(-1)).toMatchObject({
      type: "room:update",
      mode: "relay",
    });
  };

  const cleanup = () => {
    detach();
    client.stop();
  };

  return { sockets, transports, session, goLiveAndStartSwitch, cleanup };
}

describe("整合 SignalClient：切模式第 2 步逾時觸發 resync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("等不到 room:updated 逾時：resync 關舊 socket、忽略晚到廣播，新連線拿 snapshot 後依新模式重建", async () => {
    const t = setupWithSignalClient();
    await t.goLiveAndStartSwitch();

    vi.advanceTimersByTime(MODE_UPDATED_TIMEOUT_MS);
    await flush();
    expect(t.sockets[0]!.close).toHaveBeenCalledWith(1000, "resync");
    expect(t.sockets).toHaveLength(2);
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });

    // 舊 socket 晚到 room:updated 不得提前重建。
    t.sockets[0]!.receive(roomUpdated("relay"));
    await flush();
    expect(t.transports).toHaveLength(1);

    // 新 socket 重新 auth 並收到最新 snapshot（relay）。
    t.sockets[1]!.open();
    expect(t.sockets[1]!.sent[0]).toMatchObject({ type: "auth" });
    t.sockets[1]!.receive(wireSnapshot("relay"));
    await flush();
    expect(t.transports).toHaveLength(2);
    expect(t.transports[1]!.options.mode).toBe("relay");
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "starting",
      error: null,
    });

    t.cleanup();
  });

  test("room:update 請求本身先於廣播期限逾時：仍以 SignalTimeoutError 觸發 resync 而非原模式重建", async () => {
    const t = setupWithSignalClient(5_000);
    await t.goLiveAndStartSwitch();

    vi.advanceTimersByTime(5_000);
    await flush();
    expect(t.sockets[0]!.close).toHaveBeenCalledWith(1000, "resync");
    expect(t.sockets).toHaveLength(2);
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });

    t.sockets[1]!.open();
    t.sockets[1]!.receive(wireSnapshot("relay"));
    await flush();
    expect(t.transports).toHaveLength(2);
    expect(t.transports[1]!.options.mode).toBe("relay");

    t.cleanup();
  });
});
