import type { ServerMessage } from "@project/shared";
import { describe, expect, test } from "vitest";
import {
  flush,
  host,
  label,
  readySource,
  setup,
  snapshot,
  viewer,
} from "./host-session.fixtures";

// 房主重新連線、被 4000 取代、傳輸整體失敗與舊代次回呼失效。

describe("房主重新連線", () => {
  test("斷線期間保留傳輸；新的 snapshot 銷毀舊傳輸並重建，start 後才送 live:true", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "reconnecting", attempt: 1 });
    expect(t.log).toEqual([]);
    expect(t.session.getView().phase).toBe("waiting");

    t.connect();
    expect(t.log).toEqual(["destroy", "create p2p", "start"]);
    await flush();
    expect(t.client.requests).toHaveLength(0);
    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.log.at(-1)).toBe("stream:status live 電影");
  });

  test("重新連線時片源還沒就緒（重新整理後）：不重建，片源就緒後才開播", () => {
    const t = setup({ intent: true });
    t.connect();
    t.session.setSource({ stream: null, status: "idle", title: "" });
    expect(t.transports).toHaveLength(0);
    expect(t.session.getView().phase).toBe("waiting");
    t.session.setSource(readySource());
    expect(t.transports).toHaveLength(1);
  });

  test("被 4000 取代：銷毀傳輸，之後不再送任何東西", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "closed", reason: "replaced" });
    expect(t.log).toEqual(["destroy"]);
    t.session.setIntent(false);
    t.session.setSource(readySource(undefined, "別片"));
    t.client.emit(snapshot());
    expect(t.log).toEqual(["destroy"]);
  });

  test("被 4000 取代：舊分頁的開播意圖失效，回來後要手動開播", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "closed", reason: "replaced" });
    expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
    expect(t.session.getView().intent).toBe(false);
    // 不是房主明確停播：不能讓接手的分頁保存的意圖失效。
    expect(t.onExplicitStop).not.toHaveBeenCalled();
  });

  test("其他原因結束連線（離開頁面 stop()）：保留意圖，重新整理後自動恢復", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "closed", reason: "stopped" });
    expect(t.onIntentChange).not.toHaveBeenCalledWith(false);
    expect(t.session.getView().intent).toBe(true);
  });

  test("重新驗證時另一分頁已明確停播：舊意圖失效，不自動開播", async () => {
    let valid = true;
    const t = setup({ intentStillValid: () => valid });
    await t.goLive();
    t.client.state({ status: "reconnecting", attempt: 1 });
    valid = false;
    t.connect();
    expect(t.log).toEqual(["destroy"]);
    expect(t.transports).toHaveLength(1);
    expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toContain("另一個分頁");
    // 手動開播仍可以。
    t.session.setIntent(true);
    expect(t.transports).toHaveLength(2);
  });

  test("明確按停止才通知其他分頁；開播失敗自動取消意圖不算", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.reject(new Error("boom"));
    await flush();
    expect(t.session.getView().intent).toBe(false);
    expect(t.onExplicitStop).not.toHaveBeenCalled();
    t.session.setIntent(true);
    t.session.setIntent(false);
    expect(t.onExplicitStop).toHaveBeenCalledTimes(1);
  });

  test("舊代次的 start() 晚 resolve：不送 live:true", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.connect(); // 重新驗證
    expect(t.log).toEqual([
      "create p2p",
      "start",
      "destroy",
      "create p2p",
      "start",
    ]);
    t.transports[0]!.gate.resolve();
    await flush();
    expect(t.client.requests).toHaveLength(0);
    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.client.requests.map((r) => label(r.message))).toEqual([
      "stream:status live 電影",
    ]);
  });

  test("直播中傳輸整體失敗：拆掉、取消意圖、送停播並顯示錯誤", async () => {
    const t = setup();
    const transport = await t.goLive();
    transport.emitState("error");
    expect(t.log).toEqual(["destroy", "stream:status off"]);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toBeTruthy();
  });

  test("不是房主的 snapshot：什麼都不做", () => {
    const t = setup();
    t.client.state({ status: "open" });
    t.client.emit({
      ...snapshot(),
      you: { memberId: "v1", role: "member" },
    } as ServerMessage);
    t.session.setSource(readySource());
    expect(t.log).toEqual([]);
  });

  test("getView 沒變時回傳同一個物件", async () => {
    const t = setup();
    await t.goLive();
    const before = t.session.getView();
    t.client.emit({ type: "room:members", members: [host, viewer("v1")] });
    expect(t.session.getView()).toBe(before);
  });
});
