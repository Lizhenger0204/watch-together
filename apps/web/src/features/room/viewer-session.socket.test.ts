import type { ServerMessage } from "@project/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SignalClient, type SocketLike } from "../../lib/signal";
import { createFakePeerConnectionFactory } from "../transport/common/rtc-fake";
import { createP2PViewerTransport } from "../transport/p2p";
import { flush, sdp, track, useRtcFakes } from "../transport/p2p/test-fixtures";
import { FIRST_OFFER_TIMEOUT_MS, ViewerSession } from "./viewer-session";
import { signal, snapshot } from "./viewer-session.fixtures";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("WebSocket 換代與 P2P 傳輸", () => {
  useRtcFakes();

  function connect() {
    const sockets: SocketLike[] = [];
    const sent = vi.fn();
    vi.stubGlobal("window", globalThis);
    const client = new SignalClient({
      url: "ws://test.invalid",
      token: "",
      createSocket: () => {
        const socket: SocketLike = {
          readyState: 1,
          onopen: null,
          onclose: null,
          onmessage: null,
          send: (data) => sent(JSON.parse(data)),
          close: vi.fn(),
        };
        sockets.push(socket);
        return socket;
      },
    });
    const rtc = createFakePeerConnectionFactory();
    const session = new ViewerSession({
      client,
      token: "",
      roomId: "r",
      requestNewSocket: vi.fn(),
      createTransport: (options) =>
        createP2PViewerTransport({
          ...options,
          createPeerConnection: rtc.factory,
          fetchIceServers: async () => [],
        }),
    });
    session.attach();
    client.start();
    const socket = () => sockets.at(-1)!;
    const receive = (m: ServerMessage) =>
      socket().onmessage?.({ data: JSON.stringify(m) });
    const sendOffer = (id: string) =>
      receive(signal({ type: "offer", negotiationId: id, sdp: sdp() }));
    return { session, sent, rtc, socket, receive, sendOffer };
  }

  test("自動重連的 snapshot 前收到 offer、ICE：只為新 socket 建一條連線並回 answer", async () => {
    const s = connect();
    s.sendOffer("old");
    s.socket().onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    s.sendOffer("new");
    s.receive(signal({ type: "ice", negotiationId: "new", candidate: null }));
    await flush();
    expect(s.rtc.connections).toHaveLength(0);
    s.receive(snapshot({ live: true }));
    await flush();
    expect(s.rtc.connections).toHaveLength(1);
    const pc = s.rtc.connections[0]!;
    expect(pc.iceCandidateHistory).toEqual([null]);
    const answers = s.sent.mock.calls
      .flat()
      .filter((m) => m.type === "signal" && m.data.type === "answer");
    expect(answers.map((m) => m.data.negotiationId)).toEqual(["new"]);
    pc.setIceConnectionState("connected");
    await vi.advanceTimersByTimeAsync(FIRST_OFFER_TIMEOUT_MS);
    expect(s.session.getView().state).toBe("playing");
  });

  test("新 socket 沒有 offer 時不會重播上一條 socket 的暫存，照常在 20 秒逾時", async () => {
    const s = connect();
    s.sendOffer("old");
    s.socket().onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    s.receive(snapshot({ live: true }));
    await vi.advanceTimersByTimeAsync(FIRST_OFFER_TIMEOUT_MS);
    expect(s.rtc.connections).toHaveLength(0);
    expect(s.session.getView().state).toBe("failed");
  });

  test("4000 取代分頁立即關閉 PC、移除兩條 track 並取消取樣與狀態回報", async () => {
    const s = connect();
    s.receive(snapshot({ live: true }));
    s.sendOffer("current");
    await flush();
    const pc = s.rtc.connections[0]!;
    pc.fireTrack(track("audio"));
    pc.fireTrack(track("video"));
    pc.setIceConnectionState("connected");
    const stream = s.session.getView().remoteStream!;
    expect(stream.getTracks()).toHaveLength(2);
    const sample = vi.spyOn(pc, "getStats");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sample).toHaveBeenCalled();
    const reports = s.sent.mock.calls.length;
    sample.mockClear();
    s.socket().onclose?.({ code: 4000 });
    expect(pc.closed).toBe(true);
    expect(stream.getTracks()).toHaveLength(0);
    expect(s.session.getView().remoteStream).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6200);
    expect(sample).not.toHaveBeenCalled();
    expect(s.sent).toHaveBeenCalledTimes(reports);
  });
});
