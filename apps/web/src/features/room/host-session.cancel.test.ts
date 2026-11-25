import { describe, expect, test } from "vitest";
import {
  createHostTransport,
  type CreateHostTransport,
  type HostTransportOptions,
} from "../transport";
import { createFakePeerConnectionFactory } from "../transport/common/rtc-fake";
import {
  createdSlowBody,
  flush as flushTimers,
  gather,
  location,
  ROOM,
  track,
  useRelayFakes,
} from "../transport/relay/test-fixtures";
import { flush, readySource, setup, snapshot } from "./host-session.fixtures";

// 開播途中房主明確停止（streaming.md §9；取代原本「start 完成後才拆掉」的行為）：立刻作廢這次開播、銷毀傳輸、離開 starting，
// live:true 已送出就撤回；之後晚到的結果不可再改狀態或顯示開播失敗。

const idle = { intent: false, phase: "idle", error: null };

describe("開播途中按停止（假傳輸）", () => {
  test("start() 還沒完成：立刻銷毀並回到 idle；之後 start 完成也不送 live:true", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    expect(t.session.getView().phase).toBe("starting");

    t.session.setIntent(false);
    expect(t.log).toEqual(["create p2p", "start", "destroy"]);
    expect(t.session.getView()).toEqual(idle);

    t.transports[0]!.gate.resolve();
    await flush();
    expect(t.log).toEqual(["create p2p", "start", "destroy"]);
    expect(t.client.requests).toHaveLength(0);
    expect(t.session.getView()).toEqual(idle);
  });

  test("start() 失敗晚到：不顯示開播失敗", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.session.setIntent(false);
    t.transports[0]!.gate.reject(new Error("晚到的失敗"));
    await flush();
    expect(t.session.getView()).toEqual(idle);
  });

  test("live:true 已送出、ack 未到：銷毀、撤回一次停播；晚到的 ack 不恢復直播", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.resolve();
    await flush();
    expect(t.log.at(-1)).toBe("stream:status live 電影");

    t.session.setIntent(false);
    expect(t.log.slice(-2)).toEqual(["destroy", "stream:status off"]);
    expect(t.session.getView()).toEqual(idle);

    await t.client.ack("stream:status live 電影");
    await t.client.ack("stream:status off");
    expect(t.session.getView()).toEqual(idle);
    expect(t.transports).toHaveLength(1);
    expect(t.log.filter((l) => l === "stream:status off")).toHaveLength(1);
  });

  test("停止後再按開始：建立新的傳輸重新開播", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.session.setIntent(false);
    t.session.setIntent(true);
    expect(t.transports).toHaveLength(2);
    expect(t.session.getView().phase).toBe("starting");
    t.transports[0]!.gate.resolve();
    t.transports[1]!.gate.resolve();
    await flush();
    expect(
      t.log.filter((l) => l.startsWith("stream:status live")),
    ).toHaveLength(1);
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");
  });
});

describe("轉發開播途中按停止（真正的 dispatcher，假 fetch／ICE）", () => {
  const http = useRelayFakes();

  function gate<T>() {
    let open!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  function relaySetup(
    fetchIceServers: HostTransportOptions["fetchIceServers"] = async () => [],
  ) {
    const { factory, connections } = createFakePeerConnectionFactory();
    const createTransport: CreateHostTransport = (options) =>
      createHostTransport({
        ...options,
        roomId: ROOM,
        createPeerConnection: factory,
        fetchIceServers,
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

  test("ICE 回覆前按停止：立刻回到 idle；放行 ICE 後不送 WHIP、不顯示錯誤", async () => {
    const ice = gate<RTCIceServer[]>();
    const t = relaySetup(() => ice.promise);
    await flushTimers();
    expect(t.session.getView().phase).toBe("starting");

    t.session.setIntent(false);
    expect(t.session.getView()).toEqual(idle);

    ice.open([]);
    await flushTimers();
    await flushTimers();
    expect(http().posts()).toHaveLength(0);
    expect(t.connections).toHaveLength(0);
    expect(t.client.requests).toHaveLength(0);
    expect(t.session.getView()).toEqual(idle);
  });

  test("WHIP 201 標頭已到、本文未到時按停止：立刻 DELETE 並回到 idle；晚到的本文不套用", async () => {
    const t = relaySetup();
    await gather(t.connections);
    const body = createdSlowBody(http().lastPost());
    await flushTimers();
    expect(t.session.getView().phase).toBe("starting");

    t.session.setIntent(false);
    expect(t.session.getView()).toEqual(idle);
    await flushTimers();
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);

    body.finish();
    await flushTimers();
    expect(t.connections[0]!.remoteDescription).toBeNull();
    expect(http().deletes()).toHaveLength(1);
    expect(http().posts()).toHaveLength(1);
    expect(t.client.requests).toHaveLength(0);
    expect(t.session.getView()).toEqual(idle);
  });
});
