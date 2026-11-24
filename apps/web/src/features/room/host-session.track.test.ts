import { describe, expect, test } from "vitest";
import { TransportError } from "../transport";
import {
  FakeStream,
  fakeTrack,
  flush,
  host,
  readySource,
  roomUpdated,
  setup,
  snapshot,
  viewer,
} from "./host-session.fixtures";

// 換片、track 異動、畫質套用與 removePeer。片名更新（updateTitle）的到期語意也在此。

describe("換片與 track 異動", () => {
  test("換片走 replaceTrack、不重建，檢查期間不停播，片名更新", async () => {
    const t = setup();
    await t.goLive();
    t.session.setSource({ stream: null, status: "checking", title: "新片" });
    expect(t.log).toEqual(["replace video null", "replace audio null"]);
    expect(t.session.getView().phase).toBe("live");

    const next = new FakeStream(
      fakeTrack("video", "v2"),
      fakeTrack("audio", "a2"),
    );
    t.session.setSource(readySource(next, "新片"));
    expect(t.log).toEqual([
      "replace video null",
      "replace audio null",
      "replace video v2",
      "replace audio a2",
      "stream:status live 新片",
    ]);
    expect(t.transports).toHaveLength(1);
    await t.client.ack("stream:status live 新片");
    // 同樣的片名不重送
    t.session.setSource(readySource(next, "新片"));
    expect(t.client.requests).toHaveLength(0);
  });

  test("同一個 stream 的 removetrack／addtrack：只對變的 kind 呼叫 replaceTrack", async () => {
    const t = setup();
    const video = fakeTrack("video", "v1");
    const stream = new FakeStream(video, fakeTrack("audio", "a1"));
    await t.goLive(readySource(stream));

    stream.remove(video); // 影片播完，Chrome 移除 track
    t.session.setSource(readySource(stream));
    expect(t.log).toEqual(["replace video null"]);

    stream.add(fakeTrack("video", "v1b")); // 重播加入新 track
    t.session.setSource(readySource(stream));
    t.session.setSource(readySource(stream));
    expect(t.log).toEqual(["replace video null", "replace video v1b"]);
    expect(t.transports).toHaveLength(1);
  });

  test("直播中片源失敗：送停播，確認後 stop／destroy，保留意圖；片源恢復再重建", async () => {
    const t = setup();
    await t.goLive();
    t.session.setSource({ stream: null, status: "error", title: "壞片" });
    expect(t.log).toEqual([
      "replace video null",
      "replace audio null",
      "stream:status off",
    ]);
    await t.client.ack("stream:status off");
    expect(t.log.slice(-2)).toEqual(["stop", "destroy"]);
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });

    t.session.setSource(readySource(undefined, "好片"));
    expect(t.transports).toHaveLength(2);
  });

  test("直播中換成無聲片（warning）：不停播，保留傳輸，確認後補上 video", async () => {
    const t = setup();
    await t.goLive();
    t.session.setSource({ stream: null, status: "warning", title: "無聲片" });
    expect(t.log).toEqual(["replace video null", "replace audio null"]);
    expect(t.client.requests).toHaveLength(0);
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView().phase).toBe("live");

    const next = new FakeStream(fakeTrack("video", "v2"));
    t.session.setSource(readySource(next, "無聲片"));
    expect(t.log).toEqual([
      "replace video null",
      "replace audio null",
      "replace video v2",
      "stream:status live 無聲片",
    ]);
    expect(t.transports).toHaveLength(1);
  });

  test("片名 A → B → A：在 B 確認前換回 A，會重送最後的 A", async () => {
    const t = setup();
    const stream = new FakeStream(
      fakeTrack("video", "v1"),
      fakeTrack("audio", "a1"),
    );
    await t.goLive(readySource(stream, "A"));
    t.session.setSource(readySource(stream, "B"));
    expect(t.log).toEqual(["stream:status live B"]);
    t.session.setSource(readySource(stream, "A"));
    expect(t.log).toEqual(["stream:status live B", "stream:status live A"]);
    // 晚到的 B ack 忽略，A 的 ack 才是最新片名。
    await t.client.ack("stream:status live B");
    await t.client.ack("stream:status live A");
    expect(t.session.getView().phase).toBe("live");
  });

  test("空白片名轉成 null：也會送出（清掉片名）", async () => {
    const t = setup();
    const stream = new FakeStream(
      fakeTrack("video", "v1"),
      fakeTrack("audio", "a1"),
    );
    await t.goLive(readySource(stream));
    t.session.setSource(readySource(stream, ""));
    expect(t.log).toEqual(["stream:status live null"]);
    await t.client.ack("stream:status live null");
    t.session.setSource(readySource(stream, ""));
    expect(t.client.requests).toHaveLength(0);
  });
});

describe("畫質與成員", () => {
  test("畫質：送 room:update，收到 room:updated 後才 setQuality", async () => {
    const t = setup();
    const transport = await t.goLive();
    t.session.setQuality("smooth");
    expect(t.log).toEqual(["room:update quality=smooth"]);
    t.client.emit(roomUpdated("p2p", "smooth"));
    expect(t.log).toEqual(["room:update quality=smooth", "setQuality smooth"]);

    transport.setQualityResult.error = new TransportError(
      "TRACK_ERROR",
      "畫質套用失敗",
    );
    t.client.emit(roomUpdated("p2p", "high"));
    await flush();
    expect(t.session.getView().error).toBe("畫質套用失敗");
  });

  test("傳輸的 TRACK_ERROR 顯示給房主", async () => {
    const t = setup();
    const transport = await t.goLive();
    transport.emitError(
      new TransportError("TRACK_ERROR", "換軌失敗", { memberId: "v1" }),
    );
    expect(t.session.getView().error).toBe("換軌失敗");
  });

  test("removePeer：之前在線、現在離線或消失（被踢、離開）的收看者；在線者不呼叫", async () => {
    const t = setup();
    t.connect(
      snapshot({
        members: [host, viewer("v1"), viewer("v2"), viewer("v3", false)],
      }),
    );
    t.session.setSource(readySource());
    t.transports[0]!.gate.resolve();
    await flush();
    await t.client.ack("stream:status live 電影");
    t.log.length = 0;

    t.client.emit({
      type: "room:members",
      members: [
        host,
        viewer("v1"),
        viewer("v2", false),
        viewer("v3", false),
        viewer("v4"),
      ],
    });
    expect(t.log).toEqual(["removePeer v2"]);

    t.client.emit({ type: "room:members", members: [host, viewer("v4")] });
    expect(t.log).toEqual(["removePeer v2", "removePeer v1"]);
  });
});
