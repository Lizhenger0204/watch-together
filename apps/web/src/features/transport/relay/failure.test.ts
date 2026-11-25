/** 缺少本機 offer、空 SDP、同一次斷線重複回報（T-122）。房主與收看者共用；最後一段只限房主。 */
import { describe, expect, test, vi } from "vitest";
import { TransportError, type PeerConnectionFactory } from "../common";
import {
  createFakePeerConnectionFactory,
  type FakeRtcPeerConnection,
} from "../common/rtc-fake";
import { ANSWER_TIMEOUT_MS } from "./http";
import {
  created,
  createdSlowBody,
  flush,
  gather,
  location,
  makeHost,
  makeViewer,
  settle,
  useRelayFakes,
} from "./test-fixtures";

const http = useRelayFakes();

function start(role: "host" | "viewer", factory?: PeerConnectionFactory) {
  const overrides = factory ? { createPeerConnection: factory } : undefined;
  if (role === "host") {
    const { host, connections } = makeHost(undefined, overrides);
    return { transport: host, connections };
  }
  const { viewer, connections } = makeViewer(overrides);
  return { transport: viewer, connections };
}

describe.each(["host", "viewer"] as const)("%s", (role) => {
  test("收集後沒有有效的本機 offer：不送 POST，以 RELAY_FAILED 失敗並關閉連線", async () => {
    const { transport, connections } = start(role);
    const errors: string[] = [];
    transport.onError((e) => errors.push(e.code));
    const started = settle(transport.start());
    await flush();
    const pc = connections[0] as FakeRtcPeerConnection;
    Object.defineProperty(pc, "localDescription", { get: () => null });
    await gather(connections);
    expect(http().posts()).toHaveLength(0);
    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(errors).toEqual(["RELAY_FAILED"]);
    expect(pc.closed).toBe(true);

    // 失敗後仍可重新開始。
    void settle(transport.start());
    await gather(connections);
    expect(http().posts()).toHaveLength(1);
  });

  // 瀏覽器包裝層（common/rtc.ts 的 toSessionDescription）遇到空 SDP 丟 SIGNAL_ERROR；
  // 轉發沒有信令，要以 RELAY_FAILED 回報。
  const emptySdp = () => new TransportError("SIGNAL_ERROR", "SDP 缺少內容");

  test.each([
    [
      "createOffer 回空 SDP",
      (pc: FakeRtcPeerConnection) => {
        pc.createOffer = () => Promise.reject(emptySdp());
      },
    ],
    [
      "收集後的 localDescription 是空 SDP",
      (pc: FakeRtcPeerConnection) => {
        Object.defineProperty(pc, "localDescription", {
          get: () => {
            throw emptySdp();
          },
        });
      },
    ],
  ])("%s：不送 POST，以 RELAY_FAILED 失敗", async (_name, breakPc) => {
    const { factory, connections } = createFakePeerConnectionFactory();
    const { transport } = start(role, (config) => {
      const pc = factory(config) as FakeRtcPeerConnection;
      breakPc(pc);
      return pc;
    });
    const errors: string[] = [];
    transport.onError((e) => errors.push(e.code));
    const started = settle(transport.start());
    await gather(connections);
    expect(http().posts()).toHaveLength(0);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(errors).toEqual(["RELAY_FAILED"]);
  });

  test("同一次斷線（ICE 與 connection 都 failed）只回報一次 RELAY_FAILED", async () => {
    const { transport, connections } = start(role);
    const errors: string[] = [];
    const states: string[] = [];
    transport.onError((e) => errors.push(e.code));
    transport.onState((s) => states.push(s));
    void settle(transport.start());
    await gather(connections);
    created(http().lastPost());
    await flush();
    const pc = connections[0] as FakeRtcPeerConnection;
    pc.setIceConnectionState("connected");
    pc.setIceConnectionState("failed");
    pc.setConnectionState("failed");
    pc.setIceConnectionState("disconnected");
    pc.setIceConnectionState("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);
    expect(states.at(-1)).toBe(role === "host" ? "error" : "failed");
  });
});

describe("房主：start() 途中已回報連線中斷", () => {
  test("晚到的 answer 套用後不進 live：start() 以 RELAY_FAILED 拒絕、DELETE，錯誤只回報一次", async () => {
    const { host, connections } = makeHost();
    const errors: string[] = [];
    const states: string[] = [];
    host.onError((e) => errors.push(e.code));
    host.onState((s) => states.push(s));
    const started = settle(host.start());
    await gather(connections);
    const body = createdSlowBody(http().lastPost());
    await flush();

    const pc = connections[0] as FakeRtcPeerConnection;
    pc.setIceConnectionState("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);
    body.finish();
    await flush();

    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(states).not.toContain("live");
    expect(states.at(-1)).toBe("error");
    expect(errors).toEqual(["RELAY_FAILED"]);
    expect(pc.closed).toBe(true);
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);

    // 清理完成後可以重新開始。
    http().deletes()[0]!.respond(200);
    void settle(host.start());
    await gather(connections);
    expect(http().posts()).toHaveLength(2);
  });

  test("201 標頭後 answer 本文逾時：start() 以 RELAY_FAILED 拒絕並 DELETE 已登記的 Location", async () => {
    const { host, connections } = makeHost();
    const errors: string[] = [];
    host.onError((e) => errors.push(e.code));
    const started = settle(host.start());
    await gather(connections);
    createdSlowBody(http().lastPost());
    await flush();
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
    expect(started.done).toBe(false);
    expect(http().deletes()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(errors).toEqual(["RELAY_FAILED"]);
    expect(connections[0]!.remoteDescription).toBeNull();
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
  });
});
