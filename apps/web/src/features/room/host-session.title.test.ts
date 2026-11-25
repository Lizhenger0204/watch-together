import { describe, expect, test } from "vitest";
import { ApiError } from "../../lib/api";
import {
  FakeStream,
  fakeTrack,
  readySource,
  setup,
} from "./host-session.fixtures";

// 直播中的片名更新：每筆請求的序號，停播時作廢（host-session-title.ts）。

const stream = () =>
  new FakeStream(fakeTrack("video", "v1"), fakeTrack("audio", "a1"));

describe("片名請求序號", () => {
  test("停播後才回來的舊片名拒絕：不顯示錯誤", async () => {
    const t = setup();
    const s = stream();
    await t.goLive(readySource(s, "A"));
    t.session.setSource(readySource(s, "B"));
    t.session.setIntent(false);
    expect(t.log).toEqual(["stream:status live B", "stream:status off"]);
    await t.client.ack("stream:status live B", new ApiError("INTERNAL"));
    expect(t.session.getView().error).toBeNull();
    await t.client.ack("stream:status off");
    expect(t.session.getView()).toMatchObject({
      intent: false,
      phase: "idle",
      error: null,
    });
  });

  test("B → C → B：第一個 B 的拒絕不清掉最後一個 B", async () => {
    const t = setup();
    const s = stream();
    await t.goLive(readySource(s, "A"));
    t.session.setSource(readySource(s, "B"));
    t.session.setSource(readySource(s, "C"));
    t.session.setSource(readySource(s, "B"));
    expect(t.log).toEqual([
      "stream:status live B",
      "stream:status live C",
      "stream:status live B",
    ]);
    await t.client.ackFirst("stream:status live B", new ApiError("INTERNAL"));
    expect(t.session.getView().error).toBeNull();
    // 最後的 B 仍待確認：同一個片名不重送。
    t.session.setSource(readySource(s, "B"));
    expect(t.log).toHaveLength(3);
    await t.client.ack("stream:status live C");
    await t.client.ack("stream:status live B");
    // 伺服器已是 B：之後同一個片名也不重送。
    t.session.setSource(readySource(s, "B"));
    expect(t.log).toHaveLength(3);
    expect(t.session.getView()).toMatchObject({ phase: "live", error: null });
  });

  test("最新一筆被拒才顯示錯誤", async () => {
    const t = setup();
    const s = stream();
    await t.goLive(readySource(s, "A"));
    t.session.setSource(readySource(s, "B"));
    t.session.setSource(readySource(s, "C"));
    await t.client.ack("stream:status live B");
    expect(t.session.getView().error).toBeNull();
    await t.client.ack("stream:status live C", new ApiError("FORBIDDEN"));
    expect(t.session.getView().error).toBeTruthy();
  });
});
