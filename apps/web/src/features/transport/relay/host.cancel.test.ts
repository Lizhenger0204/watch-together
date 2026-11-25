/**
 * WHIP 停止時依 POST 進度取消（T-122，docs/specs/streaming.md §4）：
 * - POST 送出前：立刻釋放輪次，不等已關閉連線上的原生操作。
 * - POST 在途：保留輪次，等晚到的回應再清理。
 * - 已取得 Location（201 標頭已驗證，本文可能還在讀）：立刻送冪等的 DELETE。
 */
import { describe, expect, test, vi } from "vitest";
import {
  createFakePeerConnectionFactory,
  type FakeRtcPeerConnection,
} from "../common/rtc-fake";
import { ICE_GATHERING_TIMEOUT_MS } from "./http";
import {
  created,
  createdSlowBody,
  flush,
  gather,
  location,
  makeHost,
  settle,
  useRelayFakes,
} from "./test-fixtures";

const http = useRelayFakes();
const never = () => new Promise<never>(() => {});

describe("停止時依 POST 進度取消", () => {
  test("套用 answer 期間停止（原生操作不結束）：立刻 DELETE，start() 結束，下一次可發布", async () => {
    const first = makeHost();
    const started = settle(first.host.start());
    await gather(first.connections);
    const pc = first.connections[0] as FakeRtcPeerConnection;
    pc.setRemoteDescription = vi.fn(never);
    created(http().lastPost());
    await flush();
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);

    first.host.stop();
    await flush();
    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);

    const second = makeHost();
    void settle(second.host.start());
    await flush();
    // 舊資源還沒刪掉前，不送新的 POST。
    expect(second.connections).toHaveLength(0);
    http().deletes()[0]!.respond(200);
    await gather(second.connections);
    expect(http().posts()).toHaveLength(2);
    // DELETE 冪等：停止與晚到的檢查點不會各刪一次。
    expect(http().deletes()).toHaveLength(1);
  });

  test("POST 送出前停止（原生操作不結束）：立刻釋放輪次，start() 結束", async () => {
    const { factory, connections } = createFakePeerConnectionFactory();
    const first = makeHost(undefined, {
      createPeerConnection: (config) => {
        const pc = factory(config) as FakeRtcPeerConnection;
        pc.setLocalDescription = vi.fn(never);
        return pc;
      },
    });
    const started = settle(first.host.start());
    await vi.advanceTimersByTimeAsync(ICE_GATHERING_TIMEOUT_MS);
    expect(connections[0]!.setLocalDescription).toHaveBeenCalledTimes(1);

    first.host.stop();
    await flush();
    expect(started.done).toBe(true);
    expect(http().posts()).toHaveLength(0);

    const second = makeHost();
    void settle(second.host.start());
    await gather(second.connections);
    expect(http().posts()).toHaveLength(1);
  });

  test("等待輪次時停止：拿到輪次後立刻釋放，不卡住下一次發布", async () => {
    const first = makeHost();
    void settle(first.host.start());
    await gather(first.connections);
    created(http().lastPost());
    await flush();

    // 第二個在排隊時就停止。
    const second = makeHost();
    const secondStarted = settle(second.host.start());
    second.host.stop();
    await flush();
    expect(secondStarted.done).toBe(true);

    first.host.stop();
    http().deletes()[0]!.respond(200);
    const third = makeHost();
    void settle(third.host.start());
    await gather(third.connections);
    expect(second.connections).toHaveLength(0);
    expect(http().posts()).toHaveLength(2);
  });

  test("POST 在途時停止：start() 立刻結束，輪次留到回應處理完", async () => {
    const first = makeHost();
    const started = settle(first.host.start());
    await gather(first.connections);
    first.host.stop();
    await flush();
    expect(started.done).toBe(true);

    const second = makeHost();
    void settle(second.host.start());
    await flush();
    expect(second.connections).toHaveLength(0);
    http().lastPost().respond(409);
    await gather(second.connections);
    expect(http().deletes()).toHaveLength(0);
    expect(http().posts()).toHaveLength(2);
  });

  test("201 標頭已到、本文還沒讀完時停止：立刻 DELETE，start() 結束，下一次可發布", async () => {
    const first = makeHost();
    const started = settle(first.host.start());
    await gather(first.connections);
    const body = createdSlowBody(http().lastPost());
    await flush();

    first.host.stop();
    await flush();
    expect(started.done).toBe(true);
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);

    http().deletes()[0]!.respond(200);
    const second = makeHost();
    void settle(second.host.start());
    await gather(second.connections);
    expect(http().posts()).toHaveLength(2);

    // 本文晚到：不再套用 answer，也不重複 DELETE。
    body.finish();
    await flush();
    expect(first.connections[0]!.remoteDescription).toBeNull();
    expect(http().deletes()).toHaveLength(1);
  });
});
