import { describe, expect, test } from "vitest";
import { ApiError } from "../../lib/api";
import { SignalDisconnectedError } from "../../lib/signal";
import {
  createHostTransport,
  TransportError,
  type CreateHostTransport,
} from "../transport";
import {
  createFakePeerConnectionFactory,
  type FakeRtcPeerConnection,
} from "../transport/common/rtc-fake";
import {
  created,
  flush as flushTimers,
  gather,
  location,
  ROOM,
  track,
  useRelayFakes,
} from "../transport/relay/test-fixtures";
import {
  FakeStream,
  fakeTrack,
  flush,
  readySource,
  setup,
  snapshot,
} from "./host-session.fixtures";

// 開播流程：建立傳輸、await start()、送 live:true 的時機與失敗處理。

describe("開播", () => {
  test("start() resolve 之前不送 live:true；之後才送，ack 後是 live", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    expect(t.log).toEqual(["create p2p", "start"]);
    expect(t.session.getView().phase).toBe("starting");
    await flush();
    expect(t.client.requests).toHaveLength(0);

    const transport = t.transports[0]!;
    expect(transport.options).toMatchObject({
      mode: "p2p",
      quality: "standard",
      roomId: "room",
      token: "host-token",
    });
    transport.gate.resolve();
    await flush();
    expect(t.log).toEqual(["create p2p", "start", "stream:status live 電影"]);
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "live",
      error: null,
    });
  });

  test("還沒收到 snapshot 時不建立傳輸", () => {
    const t = setup();
    t.session.setSource(readySource());
    t.client.state({ status: "open" });
    expect(t.transports).toHaveLength(0);
    expect(t.session.getView().phase).toBe("waiting");
  });

  test("沒有開播意圖時不建立傳輸，按開始直播才建立", () => {
    const t = setup({ intent: false });
    t.connect();
    t.session.setSource(readySource());
    expect(t.transports).toHaveLength(0);
    expect(t.session.getView().phase).toBe("idle");
    t.session.setIntent(true);
    expect(t.onIntentChange).toHaveBeenCalledWith(true);
    expect(t.log).toEqual(["create p2p", "start"]);
  });

  test("start() 失敗：不送 live、拆掉傳輸、取消意圖並顯示錯誤；再按一次就重試", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.reject(
      new TransportError("SIGNAL_ERROR", "無法訂閱連線信令"),
    );
    await flush();
    expect(t.log).toEqual(["create p2p", "start", "destroy"]);
    expect(t.client.requests).toHaveLength(0);
    expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toContain("無法訂閱連線信令");

    t.session.setIntent(true);
    expect(t.session.getView().error).toBeNull();
    expect(t.transports).toHaveLength(2);
  });

  test("live:true 被伺服器拒絕：拆掉傳輸、取消意圖、顯示錯誤", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.resolve();
    await flush();
    await t.client.ack("stream:status live 電影", new ApiError("FORBIDDEN"));
    expect(t.log.at(-1)).toBe("destroy");
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toBeTruthy();
  });

  test("live:true 因斷線失敗：保留意圖不顯示錯誤，下一次 snapshot 重建", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.resolve();
    await flush();
    await t.client.ack(
      "stream:status live 電影",
      new SignalDisconnectedError(),
    );
    expect(t.log.at(-1)).toBe("destroy");
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
      error: null,
    });
    t.connect();
    expect(t.transports).toHaveLength(2);
  });

  test("start() 期間換片檢查：start 完成後拆掉舊傳輸，新片就緒後重建開播", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    // 開播途中換片，進入檢查中（stream 暫時為 null）。
    t.session.setSource({ stream: null, status: "checking", title: "新片" });
    t.transports[0]!.gate.resolve();
    await flush();
    // 舊傳輸已拆，不再卡在「直播暫停中」；不送 live:true。
    expect(t.log.at(-1)).toBe("destroy");
    expect(t.client.requests).toHaveLength(0);
    expect(t.session.getView().phase).toBe("waiting");

    const next = new FakeStream(
      fakeTrack("video", "v2"),
      fakeTrack("audio", "a2"),
    );
    t.session.setSource(readySource(next, "新片"));
    expect(t.transports).toHaveLength(2);
    expect(t.log.slice(-2)).toEqual(["create p2p", "start"]);
  });

  test("start() 因斷線失敗：保留意圖不顯示錯誤，下一次 snapshot 重建", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.reject(new SignalDisconnectedError());
    await flush();
    expect(t.log.at(-1)).toBe("destroy");
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
      error: null,
    });
    t.connect();
    expect(t.transports).toHaveLength(2);
  });

  describe("傳輸已就緒、等開播確認時傳輸失敗", () => {
    test("live:true 已送出：取消意圖、拆掉傳輸並撤回開播；晚到的 ack 不恢復", async () => {
      const t = setup();
      t.connect();
      t.session.setSource(readySource());
      const transport = t.transports[0]!;
      transport.gate.resolve();
      await flush();
      expect(t.log.at(-1)).toBe("stream:status live 電影");

      transport.emitState("error");
      expect(t.log.slice(-2)).toEqual(["destroy", "stream:status off"]);
      expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
      expect(t.session.getView()).toMatchObject({
        intent: false,
        phase: "idle",
      });
      expect(t.session.getView().error).toBeTruthy();

      // 暫存的 ack 這時才到：不可回到「直播中」，也不重建傳輸。
      await t.client.ack("stream:status live 電影");
      await t.client.ack("stream:status off");
      expect(t.session.getView()).toMatchObject({
        intent: false,
        phase: "idle",
      });
      expect(t.transports).toHaveLength(1);
      expect(t.log.at(-1)).toBe("stream:status off");
    });

    test("還在確認上一次停播：取消意圖、拆掉傳輸，之後不送 live:true", async () => {
      const t = setup();
      t.connect();
      // 上一輪的停播還沒被確認，伺服器仍是直播中。
      t.client.emit({
        type: "stream:status",
        live: true,
        title: "舊片",
        startedAt: 1,
      });
      t.session.setSource(readySource());
      const transport = t.transports[0]!;
      transport.gate.resolve();
      await flush();
      expect(t.log.at(-1)).toBe("stream:status off");

      transport.emitState("error");
      expect(t.log.at(-2)).toBe("destroy");
      expect(t.session.getView()).toMatchObject({
        intent: false,
        phase: "idle",
      });

      await t.client.ackFirst("stream:status off");
      await t.client.ack("stream:status off");
      expect(t.log.filter((l) => l.startsWith("stream:status live"))).toEqual(
        [],
      );
      expect(t.session.getView().phase).toBe("idle");
    });

    test("start() 還沒完成時的 error 狀態交給 start() 的 reject 處理，不撤回開播", async () => {
      const t = setup();
      t.connect();
      t.session.setSource(readySource());
      const transport = t.transports[0]!;
      transport.emitState("error");
      expect(t.session.getView().phase).toBe("starting");
      expect(t.client.requests).toHaveLength(0);
      transport.gate.reject(new TransportError("RELAY_FAILED", "轉發連線中斷"));
      await flush();
      expect(t.log).toEqual(["create p2p", "start", "destroy"]);
      expect(t.client.requests).toHaveLength(0);
      expect(t.session.getView().error).toContain("轉發連線中斷");
    });
  });

  describe("轉發：真正的 dispatcher（假 fetch／ICE）", () => {
    const http = useRelayFakes();

    function relaySetup() {
      const { factory, connections } = createFakePeerConnectionFactory();
      const createTransport: CreateHostTransport = (options) =>
        createHostTransport({
          ...options,
          roomId: ROOM,
          createPeerConnection: factory,
          fetchIceServers: async () => [],
          getCodecCapabilities: (kind) =>
            kind === "video"
              ? [{ mimeType: "video/H264", clockRate: 90000 }]
              : [{ mimeType: "audio/opus", clockRate: 48000 }],
        });
      const t = setup({ createTransport });
      t.connect(snapshot({ mode: "relay" }));
      const stream = new MediaStream([track("video", 1080), track("audio")]);
      t.session.setSource({ stream, status: "ready", title: "電影" });
      return { ...t, connections };
    }

    test("WHIP 回 503：顯示 RELAY_UNAVAILABLE 的可讀錯誤、取消開播意圖、不送 live:true", async () => {
      const t = relaySetup();
      await gather(t.connections);
      expect(http().posts()).toHaveLength(1);
      http()
        .lastPost()
        .respond(
          503,
          JSON.stringify({
            error: {
              code: "RELAY_UNAVAILABLE",
              message: "轉發模式目前無法使用",
            },
          }),
          { "Content-Type": "application/json" },
        );
      await flushTimers();
      expect(t.client.requests).toHaveLength(0);
      expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
      expect(t.session.getView()).toEqual({
        intent: false,
        phase: "idle",
        error: "無法開始直播：轉發模式目前無法使用，請房主改用「P2P 直連」。",
      });
    });

    test("WHIP 201 後、live:true 的 ack 前 ICE failed：送停播與 DELETE，晚到的 ack 不恢復", async () => {
      const t = relaySetup();
      await gather(t.connections);
      created(http().lastPost());
      await flushTimers();
      expect(t.log.at(-1)).toBe("stream:status live 電影");

      (t.connections[0] as FakeRtcPeerConnection).setIceConnectionState(
        "failed",
      );
      await flushTimers();
      expect(t.log.at(-1)).toBe("stream:status off");
      expect(
        http()
          .deletes()
          .map((r) => r.url),
      ).toEqual([location()]);
      expect(t.session.getView()).toMatchObject({
        intent: false,
        phase: "idle",
      });

      await t.client.ack("stream:status live 電影");
      await t.client.ack("stream:status off");
      expect(t.session.getView()).toMatchObject({
        intent: false,
        phase: "idle",
      });
      expect(http().posts()).toHaveLength(1);
    });
  });
});
