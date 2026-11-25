/** 缺少本機 offer、同一次斷線重複回報（T-122）。房主與收看者共用。 */
import { describe, expect, test } from "vitest";
import type { FakeRtcPeerConnection } from "../common/rtc-fake";
import {
  created,
  flush,
  gather,
  makeHost,
  makeViewer,
  settle,
  useRelayFakes,
} from "./test-fixtures";

const http = useRelayFakes();

function start(role: "host" | "viewer") {
  if (role === "host") {
    const { host, connections } = makeHost();
    return { transport: host, connections };
  }
  const { viewer, connections } = makeViewer();
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
