import { describe, expect, test } from "vitest";
import { createHostTransport, type CreateHostTransport } from "../transport";
import { createFakePeerConnectionFactory } from "../transport/common/rtc-fake";
import {
  flush as flushTimers,
  track as rtcTrack,
  useRtcFakes,
} from "../transport/p2p/test-fixtures";
import { host, setup, viewer } from "./host-session.fixtures";

// 整合：真的 P2P host transport + rtc-fake。

describe("整合：P2P host transport", () => {
  useRtcFakes();

  test("live:true 之後收到 peer:request，offer 經 client.send 送出；收看者離線時關閉連線", async () => {
    const { factory, connections } = createFakePeerConnectionFactory();
    const createTransport: CreateHostTransport = (options) =>
      createHostTransport({
        ...options,
        createPeerConnection: factory,
        fetchIceServers: async () => [],
        getCodecCapabilities: (kind) =>
          kind === "video"
            ? [{ mimeType: "video/H264", clockRate: 90000 }]
            : [{ mimeType: "audio/opus", clockRate: 48000 }],
      });
    const t = setup({ createTransport });
    t.connect();
    const stream = new MediaStream([
      rtcTrack("video", 1080),
      rtcTrack("audio"),
    ]);
    t.session.setSource({
      stream,
      status: "ready",
      title: "電影",
      bitrate: null,
    });
    await flushTimers();
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");

    t.client.emit({ type: "peer:request", memberId: "v1" });
    await flushTimers();
    const offer = t.client.sent.find(
      (m) => m.to === "v1" && m.data.type === "offer",
    );
    expect(offer).toBeTruthy();
    expect(connections).toHaveLength(1);

    t.client.emit({
      type: "room:members",
      members: [host, viewer("v1", false)],
    });
    expect(connections[0]!.closed).toBe(true);
  });
});
