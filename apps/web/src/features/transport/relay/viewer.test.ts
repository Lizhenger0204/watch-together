import { describe, expect, test, vi } from "vitest";
import type { FakeRtcPeerConnection } from "../common/rtc-fake";
import { DELETE_RETRY_DELAYS_MS } from "./http";
import {
  answerSdp,
  created,
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
