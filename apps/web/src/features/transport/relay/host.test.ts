import { describe, expect, test, vi } from "vitest";
import { TARGETS } from "../common/encoding.fixtures";
import type { FakeRtcPeerConnection } from "../common/rtc-fake";
import { DELETE_RETRY_DELAYS_MS, ICE_GATHERING_TIMEOUT_MS } from "./http";
import {
  answerSdp,
  created,
  flush,
  gather,
  location,
  makeHost,
  ROOM,
  settle,
  TOKEN,
  track,
  useRelayFakes,
} from "./test-fixtures";

const http = useRelayFakes();
const totalRetryMs = DELETE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

/** 建立房主並跑到 POST 送出為止。 */
async function posting(stream?: MediaStream) {
  const made = makeHost(stream);
  const started = settle(made.host.start());
  await gather(made.connections);
  const pc = made.connections.at(-1) as FakeRtcPeerConnection;
  return { ...made, started, pc };
}

/** 建立房主並完成開播。 */
async function live(stream?: MediaStream) {
  const made = await posting(stream);
  created(http().lastPost());
  await flush();
  expect(made.started).toMatchObject({ done: true, error: undefined });
  return made;
}

describe("WHIP 發布", () => {
  test("單次 HTTP offer：帶 token 與 SDP，套用 answer 後才 resolve 並進入 live", async () => {
    const { host, pc, started, fetchIceServers } = await posting();
    const states: string[] = [];
    host.onState((s) => states.push(s));

    expect(fetchIceServers).toHaveBeenCalledTimes(1);
    const post = http().lastPost();
    expect(post.url).toBe(`/api/rooms/${ROOM}/whip`);
    expect(post.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/sdp",
    });
    // 收集到的 candidate 寫進 POST body。
    expect(post.body).toContain("a=candidate:1 1 udp");
    expect(post.body).toBe(pc.localDescription?.sdp);
    expect(post.url).not.toContain(TOKEN);
    expect(started.done).toBe(false);

    created(post);
    await flush();
    expect(started).toMatchObject({ done: true, error: undefined });
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: answerSdp });
    expect(states).toEqual(["live"]);
  });

  test("ICE 收集最多等 2 秒，之後照樣送出目前的 localDescription", async () => {
    const { host, connections } = makeHost();
    void settle(host.start());
    await flush();
    expect(http().posts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(ICE_GATHERING_TIMEOUT_MS - 1);
    expect(http().posts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(http().posts()).toHaveLength(1);
    expect(http().lastPost().body).toBe(connections[0]!.localDescription?.sdp);
  });

  test("缺音軌也保留 video、audio 兩個 sendonly transceiver；之後用同一個 sender 補軌", async () => {
    const video = track("video", 1080);
    const { host, pc } = await live(new MediaStream([video]));
    const [v, a] = pc.getTransceivers();
    expect(v).toMatchObject({ kind: "video", init: { direction: "sendonly" } });
    expect(a).toMatchObject({ kind: "audio", init: { direction: "sendonly" } });
    expect(v!.sender.track).toBe(video);
    expect(a!.sender.track).toBeNull();
    expect(
      http()
        .lastPost()
        .body?.match(/a=sendonly/g),
    ).toHaveLength(2);

    const audio = track("audio");
    host.replaceTrack("audio", audio);
    await flush();
    expect(a!.sender.track).toBe(audio);
    expect(pc.getTransceivers()).toHaveLength(2);
    expect(pc.offerOptions).toHaveLength(1);
  });

  test("video 偏好 H.264、audio 只送 Opus，並套用畫質與 4K 縮放", async () => {
    const { pc } = await posting();
    const [v, a] = pc.getTransceivers();
    expect(v!.codecPreferences[0]?.mimeType).toBe("video/H264");
    expect(a!.codecPreferences.map((c) => c.mimeType)).toEqual(["audio/opus"]);
    const encoding = v!.sender.lastParameters?.encodings[0];
    expect(encoding?.scaleResolutionDownBy).toBe(2);
    expect(encoding?.maxBitrate).toBeGreaterThan(0);
  });

  test.each([
    [409, "STREAM_NOT_LIVE"],
    [503, "RELAY_UNAVAILABLE"],
    [500, "RELAY_FAILED"],
  ])("POST 回 %i → start() 以 %s 失敗，狀態 error", async (status, code) => {
    const { host, started } = await posting();
    const states: string[] = [];
    const errors: string[] = [];
    host.onState((s) => states.push(s));
    host.onError((e) => errors.push(e.code));
    http().lastPost().respond(status);
    await flush();
    expect((started.error as { code: string }).code).toBe(code);
    expect(states).toEqual(["error"]);
    expect(errors).toEqual([code]);
    expect(http().deletes()).toHaveLength(0);
  });

  test.each([
    ["其他網站", "https://evil.example/steal"],
    ["同源的其他路徑", "/api/rooms/other-room/relay/abc"],
    ["含路徑跳脫", `/api/rooms/${ROOM}/relay/../../../ice`],
  ])(
    "201 的 Location 不是本房間的資源（%s）：不 DELETE 到別處，start() 失敗",
    async (_name, bad) => {
      const { started } = await posting();
      http().lastPost().respond(201, answerSdp, { Location: bad });
      await flush();
      expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
      expect(http().deletes()).toHaveLength(0);
    },
  );
});

describe("停止與 DELETE", () => {
  test("stop() 關閉連線並 DELETE Location（帶 token、keepalive）", async () => {
    const { host, pc } = await live();
    const states: string[] = [];
    host.onState((s) => states.push(s));
    host.stop();
    expect(pc.closed).toBe(true);
    expect(states).toEqual(["idle"]);
    const del = http().deletes()[0]!;
    expect(del.url).toBe(location());
    expect(del.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(del.keepalive).toBe(true);
  });

  test("POST 送出前就停止：不送 POST，也不卡住下一次發布", async () => {
    const first = makeHost();
    const started = settle(first.host.start());
    await flush();
    first.host.stop();
    await gather(first.connections);
    await vi.advanceTimersByTimeAsync(ICE_GATHERING_TIMEOUT_MS);
    expect(http().posts()).toHaveLength(0);
    expect(started.done).toBe(true);

    const second = makeHost();
    void settle(second.host.start());
    await gather(second.connections);
    expect(http().posts()).toHaveLength(1);
  });

  test("POST 在途時停止：等回應，拿到 201 後依 Location DELETE", async () => {
    const { host, started } = await posting();
    host.stop();
    await flush();
    expect(http().deletes()).toHaveLength(0);
    created(http().lastPost());
    await flush();
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
    expect(started.done).toBe(true);
    expect(started.error).toBeDefined();
  });

  test("套用 answer 失敗：已建立的資源也要 DELETE", async () => {
    const { pc, started } = await posting();
    pc.setRemoteDescription = vi.fn(async () => {
      throw new DOMException("bad answer", "InvalidAccessError");
    });
    created(http().lastPost());
    await flush();
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");
    expect(
      http()
        .deletes()
        .map((r) => r.url),
    ).toEqual([location()]);
  });

  test("destroy() 後不再發事件，但晚到的 201 仍會 DELETE", async () => {
    const { host } = await posting();
    const events: string[] = [];
    host.onState((s) => events.push(s));
    host.onError((e) => events.push(e.code));
    host.destroy();
    created(http().lastPost());
    await flush();
    expect(events).toEqual([]);
    expect(http().deletes()).toHaveLength(1);
    await expect(host.start()).rejects.toMatchObject({ code: "RELAY_FAILED" });
  });
});

describe("同一房間的 WHIP 依序進行", () => {
  test("舊 POST 在途時重開：等舊回應並 DELETE 完成後才送新的 POST", async () => {
    const first = await posting();
    first.host.stop();
    const second = makeHost();
    void settle(second.host.start());
    await flush();
    expect(second.connections).toHaveLength(0);
    expect(http().posts()).toHaveLength(1);

    created(http().posts()[0]!, "aaaaaaaa-0000-0000-0000-000000000001");
    await flush();
    expect(http().deletes()).toHaveLength(1);
    expect(http().posts()).toHaveLength(1);

    http().deletes()[0]!.respond(200);
    await gather(second.connections);
    expect(http().posts()).toHaveLength(2);
  });

  test("開播中的舊發布 DELETE 完成前，新的發布不送 POST", async () => {
    const first = await live();
    first.host.stop();
    const second = makeHost();
    void settle(second.host.start());
    await flush();
    expect(second.connections).toHaveLength(0);
    expect(http().posts()).toHaveLength(1);
    http().deletes()[0]!.respond(200);
    await gather(second.connections);
    expect(http().posts()).toHaveLength(2);
  });

  test("DELETE 回應遺失、重試拿到 403：視為已清理，繼續下一次發布", async () => {
    const first = await live();
    first.host.stop();
    const second = makeHost();
    void settle(second.host.start());
    http().deletes()[0]!.fail();
    await vi.advanceTimersByTimeAsync(DELETE_RETRY_DELAYS_MS[0]);
    expect(http().deletes()).toHaveLength(2);
    http().deletes()[1]!.respond(403);
    await gather(second.connections);
    expect(http().posts()).toHaveLength(2);
  });

  test("DELETE 重試用盡：下一次發布先再清一次，仍失敗就不送 POST", async () => {
    const first = await live();
    first.host.stop();
    for (let i = 0; i <= DELETE_RETRY_DELAYS_MS.length; i++) {
      await flush();
      http().deletes().at(-1)!.respond(500);
      await vi.advanceTimersByTimeAsync(DELETE_RETRY_DELAYS_MS[i] ?? 0);
    }
    expect(http().deletes()).toHaveLength(4);

    const second = makeHost();
    const started = settle(second.host.start());
    for (let i = 0; i <= DELETE_RETRY_DELAYS_MS.length; i++) {
      await flush();
      http().deletes().at(-1)!.respond(500);
      await vi.advanceTimersByTimeAsync(DELETE_RETRY_DELAYS_MS[i] ?? 0);
    }
    await flush();
    expect(http().deletes()).toHaveLength(8);
    expect(http().posts()).toHaveLength(1);
    expect((started.error as { code: string }).code).toBe("RELAY_FAILED");

    // 再下一次：清理成功就照常發布。
    const third = makeHost();
    void settle(third.host.start());
    await flush();
    http().deletes().at(-1)!.respond(200);
    await gather(third.connections);
    expect(http().posts()).toHaveLength(2);
  }, 10_000);

  test("身份失效（401）的 DELETE 不重試，也不擋住下一次發布", async () => {
    const first = await live();
    first.host.stop();
    http().deletes()[0]!.respond(401);
    await vi.advanceTimersByTimeAsync(totalRetryMs);
    expect(http().deletes()).toHaveLength(1);
    const second = makeHost();
    void settle(second.host.start());
    await gather(second.connections);
    expect(http().posts()).toHaveLength(2);
  });

  test("不同房間互不影響", async () => {
    await posting();
    const other = makeHost(undefined, { roomId: "other-room" });
    void settle(other.host.start());
    await gather(other.connections);
    expect(http().posts()).toHaveLength(2);
  });
});

describe("換片、畫質、統計與其他", () => {
  test("replaceTrack 更新 sender 並依新高度重算縮放；開播前換的 track 也會用上", async () => {
    const made = makeHost(new MediaStream([track("video", 2160)]));
    const early = track("video", 720);
    void settle(made.host.start());
    made.host.replaceTrack("video", early);
    await gather(made.connections);
    const pc = made.connections[0]!;
    const sender = pc.getTransceivers()[0]!.sender;
    expect(sender.track).toBe(early);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(1);

    created(http().lastPost());
    await flush();
    const next = track("video", 2160);
    made.host.replaceTrack("video", next);
    await flush();
    expect(sender.track).toBe(next);
    expect(sender.lastParameters?.encodings[0]?.scaleResolutionDownBy).toBe(2);
  });

  test("setQuality 套用到 video sender；失敗時回報 TRACK_ERROR 並 reject", async () => {
    const { host, pc } = await live();
    const sender = pc.getTransceivers()[0]!.sender;
    await host.setQuality(TARGETS.smooth);
    const smooth = sender.lastParameters?.encodings[0]?.maxBitrate;
    await host.setQuality(TARGETS.high);
    expect(sender.lastParameters?.encodings[0]?.maxBitrate).toBeGreaterThan(
      smooth ?? 0,
    );

    const errors: unknown[] = [];
    host.onError((e) => errors.push(e));
    sender.setParameters = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(host.setQuality(TARGETS.smooth)).rejects.toMatchObject({
      code: "TRACK_ERROR",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toHaveProperty("memberId", expect.anything());
  });

  test("ICE 連通後每 2 秒回報上傳統計（沒有 memberId）；連線失敗進入 error", async () => {
    const { host, pc } = await live();
    const stats: unknown[] = [];
    const errors: string[] = [];
    const states: string[] = [];
    host.onStats((s) => stats.push(s));
    host.onError((e) => errors.push(e.code));
    host.onState((s) => states.push(s));
    pc.setIceConnectionState("connected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stats).toEqual([{ bitrateKbps: 0 }]);
    pc.setIceConnectionState("failed");
    expect(states).toEqual(["error"]);
    expect(errors).toEqual(["RELAY_FAILED"]);
  });

  test("removePeer 是 no-op，onPeerState 不會觸發", async () => {
    const { host } = await live();
    const peers: unknown[] = [];
    host.onPeerState((p) => peers.push(p));
    host.removePeer("someone");
    expect(peers).toEqual([]);
    expect(http().deletes()).toHaveLength(0);
  });

  test("重複呼叫 start() 回傳同一個 Promise，只送一次 POST", async () => {
    const { host, connections } = makeHost();
    const a = host.start();
    const b = host.start();
    expect(a).toBe(b);
    void settle(a);
    await gather(connections);
    expect(http().posts()).toHaveLength(1);
  });

  test("沒有把 track 停掉（T-106 擁有 capture track）", async () => {
    const video = track("video", 1080);
    const { host } = await live(new MediaStream([video]));
    host.destroy();
    expect(video.stop).not.toHaveBeenCalled();
  });
});
