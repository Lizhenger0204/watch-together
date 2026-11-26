import { MEMBER_STATUS_INTERVAL_MS, type SignalData } from "@project/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TransportError } from "../transport";
import { FIRST_OFFER_TIMEOUT_MS } from "./viewer-session";
import {
  HOST,
  live,
  modeUpdate,
  offer,
  setup,
  signal,
  snapshot,
} from "./viewer-session.fixtures";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("建立與拆除傳輸", () => {
  test("snapshot 未開播：不建立傳輸，回報 waiting；開播廣播後才建立", () => {
    const s = setup();
    s.receive(snapshot());
    expect(s.createTransport).not.toHaveBeenCalled();
    expect(s.session.getView()).toMatchObject({
      live: false,
      state: "waiting",
    });
    s.receive(live(true));
    expect(s.createTransport).toHaveBeenCalledTimes(1);
    expect(s.session.getView()).toMatchObject({
      live: true,
      state: "connecting",
      remoteStream: s.last().remoteStream,
    });
  });

  test("已經開播才加入：snapshot 就建立傳輸，帶入 mode、roomId、token", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    expect(s.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "p2p",
        roomId: "r",
        token: "member-token",
      }),
    );
  });

  test("房主不建立收看傳輸，也不回報 member:status", () => {
    const s = setup();
    s.receive(snapshot({ live: true, role: "host" }));
    vi.advanceTimersByTime(MEMBER_STATUS_INTERVAL_MS * 2);
    expect(s.createTransport).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
  });

  test("停播：銷毀傳輸並回到 waiting；重複的開播廣播不重建", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    s.receive(live(true));
    expect(s.createTransport).toHaveBeenCalledTimes(1);
    s.receive(live(false));
    expect(s.last().destroyed).toBe(true);
    expect(s.session.getView()).toMatchObject({
      live: false,
      state: "waiting",
      remoteStream: null,
    });
  });

  test("新的 snapshot（換 WebSocket）拆掉舊傳輸再重建", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    const first = s.last();
    s.receive(snapshot({ live: true }));
    expect(first.destroyed).toBe(true);
    expect(s.transports).toHaveLength(2);
  });

  test("直播中切模式：銷毀舊傳輸，依新模式重建", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    s.receive(modeUpdate("relay"));
    expect(s.transports[0]!.destroyed).toBe(true);
    expect(s.last().mode).toBe("relay");
  });

  test.each(["p2p", "relay"] as const)(
    "停播切到 %s 時建立新傳輸，重開播沿用同一份",
    async (mode) => {
      const s = setup();
      s.receive(
        snapshot({ live: true, mode: mode === "p2p" ? "relay" : "p2p" }),
      );
      const old = s.last();
      s.receive(live(false));
      s.receive(modeUpdate(mode));
      const prepared = s.last();
      expect(old.destroyed).toBe(true);
      expect(prepared.mode).toBe(mode);
      if (mode === "relay") expect(prepared.start).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS * 2);
      expect(s.session.getView().state).toBe("waiting");
      if (mode === "p2p") s.receive(signal(offer("reopened")));
      s.receive(live(true));
      s.receive(live(true));
      await prepared.ready();
      expect(s.last()).toBe(prepared);
      expect(prepared.start).toHaveBeenCalledTimes(1);
      if (mode === "p2p") {
        expect(prepared.received.map((m) => m.data)).toEqual([
          offer("reopened"),
        ]);
        vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS);
        expect(prepared.destroyed).toBe(false);
      }
    },
  );

  test("預建 P2P 後再次停播，先前暫存的 offer 不交給下次直播", async () => {
    const s = setup();
    s.receive(snapshot({ mode: "relay" }));
    s.receive(modeUpdate("p2p"));
    s.receive(signal(offer("cancelled")));
    s.receive(live(false));
    s.receive(live(true));
    s.receive(signal(offer("next")));
    const transport = s.last();
    await transport.ready();
    expect(transport.received.map((m) => m.data)).toEqual([offer("next")]);
  });

  test("建立傳輸失敗（轉發尚未支援）：顯示 failed 與錯誤", () => {
    const s = setup();
    s.createTransport.mockImplementationOnce(() => {
      throw new TransportError("RELAY_UNAVAILABLE", "轉發模式還沒完成");
    });
    s.receive(snapshot({ live: true, mode: "relay" }));
    expect(s.session.getView()).toMatchObject({ state: "failed" });
    expect(s.session.getView().error?.code).toBe("RELAY_UNAVAILABLE");
  });
});

describe("信令緩衝", () => {
  test("訂閱就緒前到的 offer／ICE 先暫存，start() resolve 後依序交付", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    const t = s.last();
    s.receive(signal(offer("n1")));
    s.receive(signal({ type: "ice", negotiationId: "n1", candidate: null }));
    expect(t.received).toEqual([]);
    await t.ready();
    expect(t.received.map((m) => m.data.type)).toEqual(["offer", "ice"]);
    s.receive(signal({ type: "ice", negotiationId: "n1", candidate: null }));
    expect(t.received).toHaveLength(3);
  });

  test("沒有傳輸時（未開播）收到的信令直接丟棄，不交給下一次傳輸", async () => {
    const s = setup();
    s.receive(snapshot());
    s.receive(signal(offer("old")));
    s.receive(live(true));
    await s.last().ready();
    expect(s.last().received).toEqual([]);
  });

  test("snapshot 確認未開播、房主或轉發模式時丟棄先到的信令", async () => {
    for (const opts of [
      { live: false },
      { live: true, role: "host" },
      { live: true, mode: "relay" },
    ] as const) {
      const s = setup();
      s.receive(signal(offer("stale")));
      s.receive(snapshot(opts));
      s.receive(live(true));
      for (const transport of s.transports) {
        await transport.ready();
        expect(transport.received).toEqual([]);
      }
      s.detach();
    }
  });

  test("snapshot 和訂閱前的暫存有上限，滿載後仍可接收新協商", async () => {
    const s = setup();
    const ice = signal({ type: "ice", negotiationId: "busy", candidate: null });
    s.receive(signal(offer("busy")));
    for (let i = 0; i < 1000; i++) s.receive(ice);
    s.receive(snapshot({ live: true }));
    for (let i = 0; i < 1000; i++) s.receive(ice);
    await s.last().ready();
    expect(s.last().received[0]?.data).toEqual(offer("busy"));
    expect(s.last().received.length).toBeLessThanOrEqual(128);

    const fresh = setup();
    for (let i = 0; i < 1000; i++) fresh.receive(ice);
    fresh.receive(signal(offer("latest")));
    fresh.receive(snapshot({ live: true }));
    await fresh.last().ready();
    expect(fresh.last().received.at(-1)?.data).toEqual(offer("latest"));
  });

  test("停播後舊傳輸的暫存信令作廢", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    const first = s.last();
    s.receive(signal(offer("n1")));
    s.receive(live(false));
    s.receive(live(true));
    await first.ready();
    await s.last().ready();
    expect(first.received).toEqual([]);
    expect(s.last().received).toEqual([]);
  });

  test("傳輸送出的 signal 經 WebSocket 轉給房主；拆掉後不再送", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    const t = s.last();
    const answer: SignalData = {
      type: "answer",
      negotiationId: "n1",
      sdp: "a",
    };
    expect(t.options.signal.sendSignal(HOST, answer)).toBe(true);
    expect(s.sent).toContainEqual({ type: "signal", to: HOST, data: answer });
    s.receive(live(false));
    expect(t.options.signal.sendSignal(HOST, answer)).toBe(false);
  });
});

describe("等待首份 offer（P2P，20 秒）", () => {
  test("訂閱就緒後 20 秒內沒有 offer：銷毀傳輸並顯示 PEER_FAILED", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    await s.last().ready();
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS - 1);
    expect(s.session.getView().state).toBe("connecting");
    vi.advanceTimersByTime(1);
    expect(s.last().destroyed).toBe(true);
    expect(s.session.getView()).toMatchObject({ state: "failed", live: true });
    expect(s.session.getView().error?.code).toBe("PEER_FAILED");
  });

  test("期限內收到 offer 就取消計時", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    await s.last().ready();
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS - 1);
    s.receive(signal(offer("n1")));
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS);
    expect(s.session.getView().state).toBe("connecting");
    expect(s.last().destroyed).toBe(false);
  });

  test("訂閱就緒前已緩衝 offer：不啟動計時", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    s.receive(signal(offer("n1")));
    await s.last().ready();
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS * 2);
    expect(s.session.getView().state).toBe("connecting");
  });

  test("計時從訂閱就緒才開始，不是從建立傳輸", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS * 2);
    expect(s.session.getView().state).toBe("connecting");
    await s.last().ready();
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS);
    expect(s.session.getView().state).toBe("failed");
  });

  test("停播取消計時；轉發模式不計時", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    await s.last().ready();
    s.receive(live(false));
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS);
    expect(s.session.getView().state).toBe("waiting");

    const r = setup();
    r.receive(snapshot({ live: true, mode: "relay" }));
    await r.last().ready();
    vi.advanceTimersByTime(FIRST_OFFER_TIMEOUT_MS);
    expect(r.session.getView().state).toBe("connecting");
  });

  test("start() 失敗：顯示 failed", async () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    await s.last().failStart(new TransportError("SIGNAL_ERROR", "x"));
    expect(s.session.getView()).toMatchObject({ state: "failed" });
    expect(s.session.getView().error?.code).toBe("SIGNAL_ERROR");
  });
});

describe("手動重新連線", () => {
  test("P2P：銷毀舊傳輸並要求換新的 WebSocket", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    s.session.reconnect();
    expect(s.transports[0]!.destroyed).toBe(true);
    expect(s.requestNewSocket).toHaveBeenCalledTimes(1);
    expect(s.createTransport).toHaveBeenCalledTimes(1);
  });

  test("轉發：直接重建傳輸，不換 WebSocket", () => {
    const s = setup();
    s.receive(snapshot({ live: true, mode: "relay" }));
    s.session.reconnect();
    expect(s.requestNewSocket).not.toHaveBeenCalled();
    expect(s.transports).toHaveLength(2);
    expect(s.transports[0]!.destroyed).toBe(true);
  });
});

describe("member:status 回報", () => {
  test("狀態改變立即回報，之後每 5 秒回報一次", () => {
    const s = setup();
    s.receive(snapshot());
    expect(s.statuses()).toEqual(["waiting"]);
    s.receive(live(true));
    expect(s.statuses()).toEqual(["waiting", "connecting"]);
    vi.advanceTimersByTime(MEMBER_STATUS_INTERVAL_MS);
    expect(s.statuses()).toEqual(["waiting", "connecting", "connecting"]);
  });

  test("播放中帶統計（缺值省略）；buffering 由播放器回報並覆蓋 playing", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    const t = s.last();
    t.events.emit("state", "playing");
    t.events.emit("stats", {
      bitrateKbps: 5000,
      rttMs: 40,
      // 即使傳輸層意外帶入房主方向統計，收看者也不可送進 member:status（streaming.md §8）。
      frameHeight: 2160,
      framesPerSecond: 30,
      qualityLimitationReason: "cpu",
    });
    vi.advanceTimersByTime(MEMBER_STATUS_INTERVAL_MS);
    expect(s.sent.at(-1)).toEqual({
      type: "member:status",
      state: "playing",
      bitrateKbps: 5000,
      rttMs: 40,
    });
    s.session.setBuffering(true);
    expect(s.sent.at(-1)).toMatchObject({ state: "buffering" });
    expect(s.session.getView().state).toBe("buffering");
    s.session.setBuffering(false);
    expect(s.sent.at(-1)).toMatchObject({ state: "playing" });
  });

  test("等待中不帶統計；STREAM_NOT_LIVE 不當成錯誤顯示", () => {
    const s = setup();
    s.receive(snapshot({ live: true, mode: "relay" }));
    const t = s.last();
    t.events.emit("stats", { bitrateKbps: 1 });
    t.events.emit("error", new TransportError("STREAM_NOT_LIVE", "x"));
    t.events.emit("state", "waiting");
    vi.advanceTimersByTime(MEMBER_STATUS_INTERVAL_MS);
    expect(s.sent.at(-1)).toEqual({ type: "member:status", state: "waiting" });
    expect(s.session.getView().error).toBeNull();
  });

  test("detach 後停止回報並銷毀傳輸，舊傳輸晚到的事件不影響畫面", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    const t = s.last();
    const count = s.sent.length;
    s.detach();
    t.events.emit("state", "playing");
    vi.advanceTimersByTime(MEMBER_STATUS_INTERVAL_MS * 3);
    expect(t.destroyed).toBe(true);
    expect(s.sent).toHaveLength(count);
  });

  test("舊傳輸的狀態事件在拆掉後不再影響畫面", () => {
    const s = setup();
    s.receive(snapshot({ live: true }));
    const old = s.last();
    s.receive(snapshot({ live: true }));
    old.events.emit("state", "failed");
    expect(s.session.getView().state).toBe("connecting");
  });
});
