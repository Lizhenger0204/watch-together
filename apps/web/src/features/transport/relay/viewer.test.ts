import { describe, expect, test, vi } from "vitest";
import type { FakeRtcPeerConnection } from "../common/rtc-fake";
import { DELETE_RETRY_DELAYS_MS } from "./http";
import {
  answerSdp,
  created,
  createdSlowBody,
  flush,
  gather,
  location,
  makeViewer,
  ROOM,
  settle,
  TOKEN,
  track,
  useRelayFakes,
} from "./test-fixtures";

const http = useRelayFakes();

async function posting() {
  const made = makeViewer();
  const states: string[] = [];
  const errors: string[] = [];
  made.viewer.onState((s) => states.push(s));
  made.viewer.onError((e) => errors.push(e.code));
  const started = settle(made.viewer.start());
  await gather(made.connections);
  const pc = made.connections.at(-1) as FakeRtcPeerConnection;
  return { ...made, started, pc, states, errors };
}

async function pulled() {
  const made = await posting();
  created(http().lastPost());
  await flush();
  expect(made.started).toMatchObject({ done: true, error: undefined });
  return made;
}

describe("WHEP 拉取", () => {
  test("video、audio 各一個 recvonly；單次 HTTP offer 帶 token 與收集到的 candidate", async () => {
    const { pc, started, states } = await posting();
    expect(states).toEqual(["connecting"]);
    expect(
      pc.getTransceivers().map((t) => [t.kind, t.init?.direction]),
    ).toEqual([
      ["video", "recvonly"],
      ["audio", "recvonly"],
    ]);
    const [videoTransceiver, audioTransceiver] = pc.getTransceivers();
    expect(videoTransceiver?.codecPreferences.map((c) => c.mimeType)).toEqual([
      "video/H264",
      "video/VP8",
    ]);
    expect(audioTransceiver?.codecPreferences.map((c) => c.mimeType)).toEqual([
      "audio/opus",
    ]);
    const post = http().lastPost();
    expect(post.url).toBe(`/api/rooms/${ROOM}/whep`);
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.headers["content-type"]).toBe("application/sdp");
    expect(post.body).toContain("a=candidate:1 1 udp");
    expect(started.done).toBe(false);

    created(post);
    await flush();
    expect(started).toMatchObject({ done: true, error: undefined });
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: answerSdp });
  });

  test("ontrack 用 event.track 加進固定的 remoteStream；ICE 連通後 playing", async () => {
    const { viewer, pc, states } = await pulled();
    const stream = viewer.remoteStream;
    const video = track("video");
    const audio = track("audio");
    pc.fireTrack(video);
    pc.fireTrack(audio);
    expect(viewer.remoteStream).toBe(stream);
    expect(stream.getTracks()).toEqual([video, audio]);
    pc.setIceConnectionState("checking");
    pc.setIceConnectionState("connected");
    expect(states).toEqual(["connecting", "playing"]);
  });

  test("409：回到 waiting，start() 以 STREAM_NOT_LIVE 結束，可再 start()", async () => {
    const { viewer, started, states, errors, pc } = await posting();
    http().lastPost().respond(409);
    await flush();
    expect((started.error as { code: string }).code).toBe("STREAM_NOT_LIVE");
    expect(states).toEqual(["connecting", "waiting"]);
    expect(errors).toEqual(["STREAM_NOT_LIVE"]);
    expect(pc.closed).toBe(true);

    void settle(viewer.start());
    await flush();
    expect(states.at(-1)).toBe("connecting");
  });

  test("503：failed 並回報 RELAY_UNAVAILABLE", async () => {
    const { started, states, errors } = await posting();
    http().lastPost().respond(503);
    await flush();
    expect((started.error as { code: string }).code).toBe("RELAY_UNAVAILABLE");
    expect(states.at(-1)).toBe("failed");
    expect(errors).toEqual(["RELAY_UNAVAILABLE"]);
  });

  test("ICE 失敗：failed 並回報 RELAY_FAILED（不自動重試）", async () => {
    const { pc, states, errors } = await pulled();
    pc.setIceConnectionState("connected");
    pc.setIceConnectionState("failed");
    expect(states.at(-1)).toBe("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);
    expect(http().posts()).toHaveLength(1);
  });

  test("連通後每 2 秒回報接收統計", async () => {
    const { viewer, pc } = await pulled();
    const stats: unknown[] = [];
    viewer.onStats((s) => stats.push(s));
    pc.setIceConnectionState("connected");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(stats).toEqual([{ bitrateKbps: 0 }, { bitrateKbps: 0 }]);
  });
});

describe("停止與清理", () => {
  test("stop()：關閉連線、移除 track、DELETE 資源，回到 waiting", async () => {
    const { viewer, pc, states } = await pulled();
    pc.fireTrack(track("video"));
    viewer.stop();
    expect(pc.closed).toBe(true);
    expect(viewer.remoteStream.getTracks()).toEqual([]);
    expect(states.at(-1)).toBe("waiting");
    const del = http().deletes()[0]!;
    expect(del.url).toBe(location());
    expect(del.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(del.keepalive).toBe(true);
  });

  test("POST 在途時停止：晚到的 201 仍會 DELETE，且不改變狀態", async () => {
    const { viewer, states } = await posting();
    viewer.stop();
    expect(http().deletes()).toHaveLength(0);
    created(http().lastPost());
    await flush();
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
    expect(states).toEqual(["connecting", "waiting"]);
  });

  test("201 標頭已到、本文還沒讀完時停止：立刻 DELETE，本文晚到也不再套用", async () => {
    const { viewer, pc, states } = await posting();
    const body = createdSlowBody(http().lastPost());
    await flush();
    viewer.stop();
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
    body.finish();
    await flush();
    expect(pc.remoteDescription).toBeNull();
    expect(http().deletes()).toHaveLength(1);
    expect(states.at(-1)).toBe("waiting");
  });

  test("套用 answer 失敗：DELETE 已建立的資源，failed", async () => {
    const { pc, started, states } = await posting();
    pc.setRemoteDescription = vi.fn(async () => {
      throw new DOMException("bad", "InvalidAccessError");
    });
    created(http().lastPost());
    await flush();
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(states.at(-1)).toBe("failed");
    expect(http().deletes()).toHaveLength(1);
  });

  test("DELETE 失敗會重試；重試拿到 403 視為已刪除", async () => {
    const { viewer } = await pulled();
    viewer.stop();
    http().deletes()[0]!.fail();
    await vi.advanceTimersByTimeAsync(DELETE_RETRY_DELAYS_MS[0]);
    http().deletes()[1]!.respond(403);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http().deletes()).toHaveLength(2);
  });

  test("destroy()：不再發事件，晚到的 201 仍會 DELETE；之後 start() 失敗", async () => {
    const { viewer, states, errors } = await posting();
    viewer.destroy();
    created(http().lastPost());
    await flush();
    expect(http().deletes()).toHaveLength(1);
    expect(states).toEqual(["connecting"]);
    expect(errors).toEqual([]);
    await expect(viewer.start()).rejects.toMatchObject({
      code: "RELAY_FAILED",
    });
  });

  test("ICE 取得失敗：不送 POST，failed 並回報 ICE_UNAVAILABLE", async () => {
    const made = makeViewer({
      fetchIceServers: async () => {
        throw new Error("down");
      },
    });
    const errors: string[] = [];
    made.viewer.onError((e) => errors.push(e.code));
    const started = settle(made.viewer.start());
    await flush();
    expect((started.error as { code: string }).code).toBe("ICE_UNAVAILABLE");
    expect(errors).toEqual(["ICE_UNAVAILABLE"]);
    expect(http().posts()).toHaveLength(0);
  });
});

describe("start() 途中已回報連線中斷", () => {
  test("讀 answer 期間 pc 進入 failed：不呼叫 setRemoteDescription、start() 拒絕 RELAY_FAILED、DELETE 且不重複報錯也不送 stats", async () => {
    const { viewer, pc, started, states, errors } = await posting();
    const stats: unknown[] = [];
    viewer.onStats((s) => stats.push(s));
    const setRemote = vi.spyOn(pc, "setRemoteDescription");
    const getStats = vi.spyOn(pc, "getStats");
    const body = createdSlowBody(http().lastPost());
    await flush();

    pc.setIceConnectionState("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);
    body.finish();
    await flush();

    expect(setRemote).not.toHaveBeenCalled();
    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
    expect(pc.closed).toBe(true);
    expect(states.at(-1)).toBe("failed");
    expect(states).not.toContain("playing");
    expect(errors).toEqual(["RELAY_FAILED"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getStats).not.toHaveBeenCalled();
    expect(stats).toEqual([]);
  });

  test("setRemoteDescription 進行中 pc 進入 failed：start() 拒絕 RELAY_FAILED、DELETE、清 track 且不重複報錯也不送 stats", async () => {
    const { viewer, pc, started, states, errors } = await posting();
    const stats: unknown[] = [];
    viewer.onStats((s) => stats.push(s));
    const getStats = vi.spyOn(pc, "getStats");
    let resolveRemote!: () => void;
    const setRemote = vi.spyOn(pc, "setRemoteDescription").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRemote = resolve;
        }),
    );
    created(http().lastPost());
    await flush();
    expect(setRemote).toHaveBeenCalledTimes(1);

    pc.fireTrack(track("video"));
    pc.fireTrack(track("audio"));
    expect(viewer.remoteStream.getTracks()).toHaveLength(2);

    pc.setIceConnectionState("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);
    resolveRemote();
    await flush();

    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
    expect(pc.closed).toBe(true);
    expect(viewer.remoteStream.getTracks()).toEqual([]);
    expect(states.at(-1)).toBe("failed");
    expect(states).not.toContain("playing");
    expect(errors).toEqual(["RELAY_FAILED"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getStats).not.toHaveBeenCalled();
    expect(stats).toEqual([]);
  });

  test("最後 check() 前 pc.connectionState 已為 failed（未先觸發事件）：start() 拒絕 RELAY_FAILED、關閉 PC、DELETE 且不啟動 stats", async () => {
    const { viewer, pc, started, states, errors } = await posting();
    const stats: unknown[] = [];
    viewer.onStats((s) => stats.push(s));
    const getStats = vi.spyOn(pc, "getStats");
    vi.spyOn(pc, "setRemoteDescription").mockImplementation(async () => {
      // 模擬瀏覽器狀態已轉成 failed，但尚未先觸發 onconnectionstatechange。
      pc.connectionState = "failed";
    });

    created(http().lastPost());
    await flush();

    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(pc.closed).toBe(true);
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
    expect(states.at(-1)).toBe("failed");
    expect(states).not.toContain("playing");
    expect(errors).toEqual(["RELAY_FAILED"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getStats).not.toHaveBeenCalled();
    expect(stats).toEqual([]);
  });

  test("WHEP POST 在途時 pc 進入 failed：立刻結束當次 start()、關閉 PC、允許重新 start()，晚到 201 仍補刪", async () => {
    const { viewer, pc, connections, started, states, errors } =
      await posting();
    const stalePost = http().lastPost();

    pc.setIceConnectionState("failed");
    await flush();

    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(pc.closed).toBe(true);
    expect(states.at(-1)).toBe("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);

    // 下一次 start() 不會沿用舊 Promise，會建新連線並送出新的 POST。
    const retry = settle(viewer.start());
    await gather(connections);
    expect(connections).toHaveLength(2);
    expect(http().posts()).toHaveLength(2);

    // 舊 POST 晚到 201：補刪舊 Location，且不影響新連線狀態。
    const staleId = "11111111-1111-4111-8111-111111111111";
    created(stalePost, staleId);
    await flush();
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location(staleId)]);
    expect(retry.done).toBe(false);
    expect(states.at(-1)).toBe("connecting");
  });

  test("ICE 收集期間 pc 進入 failed：不送 POST、立刻拒絕並關閉 PC，可立即重新 start()", async () => {
    const { viewer, connections } = makeViewer();
    const states: string[] = [];
    const errors: string[] = [];
    viewer.onState((s) => states.push(s));
    viewer.onError((e) => errors.push(e.code));

    const started = settle(viewer.start());
    await flush();
    const pc = connections[0] as FakeRtcPeerConnection;
    pc.setIceConnectionState("failed");
    await gather(connections);

    expect(http().posts()).toHaveLength(0);
    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(pc.closed).toBe(true);
    expect(states.at(-1)).toBe("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);

    void settle(viewer.start());
    await gather(connections);
    expect(connections).toHaveLength(2);
    expect(http().posts()).toHaveLength(1);
  });

  test("POST 在途時已觸發 failed，隨後 POST 回 409：維持 failed 與 RELAY_FAILED，不被 409 蓋成 waiting", async () => {
    const { pc, started, states, errors } = await posting();
    const post = http().lastPost();

    pc.setIceConnectionState("failed");
    post.respond(409);
    await flush();

    expect(started.done).toBe(true);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(states.at(-1)).toBe("failed");
    expect(errors).toEqual(["RELAY_FAILED"]);
  });
});
