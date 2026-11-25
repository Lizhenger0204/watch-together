import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { SignalDisconnectedError, SignalTimeoutError } from "../../lib/signal";
import { MODE_UPDATED_TIMEOUT_MS } from "./host-session-base";
import {
  flush,
  readySource,
  roomUpdated,
  setup,
  snapshot,
} from "./host-session.fixtures";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// 停播與直播中切模式（streaming.md §6「房主」1～4 步）。

describe("停播", () => {
  test("送 live:false，ack 之後才 stop／destroy", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    expect(t.log).toEqual(["stream:status off"]);
    expect(t.session.getView().phase).toBe("stopping");
    await t.client.ack("stream:status off");
    expect(t.log).toEqual(["stream:status off", "stop", "destroy"]);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
  });

  test("停播廣播先到也算確認", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    t.client.emit({
      type: "stream:status",
      live: false,
      title: null,
      startedAt: null,
    });
    await flush();
    expect(t.log).toEqual(["stream:status off", "stop", "destroy"]);
  });

  test("停播被拒：仍拆掉傳輸並顯示錯誤", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    await t.client.ack("stream:status off", new ApiError("INTERNAL"));
    expect(t.log).toEqual(["stream:status off", "destroy"]);
    expect(t.session.getView().error).toBeTruthy();
  });

  test("停播逾時後再重開：先確認停播才送 live:true", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    await t.client.ack("stream:status off", new ApiError("INTERNAL"));
    expect(t.session.getView().phase).toBe("idle");

    t.session.setIntent(true);
    t.transports[1]!.gate.resolve();
    await flush();
    // 停播尚未確認（serverLive 仍是 true），先重送 live:false 強制確認。
    expect(t.log.slice(-2)).toEqual(["start", "stream:status off"]);
    await t.client.ack("stream:status off");
    expect(t.log.at(-1)).toBe("stream:status live 電影");
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");
  });

  test("停播已由廣播確認、重新開播後，晚到的停播 ack 不覆寫直播狀態", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    t.client.emit({
      type: "stream:status",
      live: false,
      title: null,
      startedAt: null,
    });
    await flush();
    t.session.setIntent(true);
    t.transports[1]!.gate.resolve();
    await flush();
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");

    await t.client.ack("stream:status off"); // 第一次停播的 ack 現在才到
    expect(t.session.getView().phase).toBe("live");
    t.log.length = 0;
    t.session.setIntent(false);
    // 伺服器仍在直播：要送 live:false，不能直接拆掉。
    expect(t.log).toEqual(["stream:status off"]);
  });

  test("重開前等停播確認時又按停止：確認後不送 live:true", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    await t.client.ack("stream:status off", new ApiError("INTERNAL"));
    t.session.setIntent(true);
    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.log.slice(-2)).toEqual(["start", "stream:status off"]);
    t.session.setIntent(false);
    await t.client.ack("stream:status off");
    expect(t.log).not.toContain("stream:status live 電影");
    expect(t.log.at(-1)).toBe("destroy");
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
  });
});

describe("直播中切模式", () => {
  test("1 停播並等 ack → 2 stop、room:update、room:updated 後 destroy → 3 建新傳輸 start → 4 live:true", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    expect(t.session.getView().phase).toBe("switching");
    expect(t.log).toEqual(["stream:status off"]);

    await t.client.ack("stream:status off");
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "room:update mode=relay",
    ]);

    t.client.emit(roomUpdated("relay"));
    await flush();
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "room:update mode=relay",
      "destroy",
      "create relay",
      "start",
    ]);
    expect(t.session.getView().phase).toBe("starting");

    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.log.at(-1)).toBe("stream:status live 電影");
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");
    expect(t.transports[1]!.options.mode).toBe("relay");
  });

  test("第 1 步以本次之後的停播廣播確認，也能進第 2 步", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    t.client.emit({
      type: "stream:status",
      live: false,
      title: null,
      startedAt: null,
    });
    await flush();
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "room:update mode=relay",
    ]);
  });

  test("第 1 步失敗或逾時：停在第 1 步，不送 room:update、不停舊傳輸", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    // SignalClient.request 逾時以 ApiError("INTERNAL") reject。
    await t.client.ack("stream:status off", new ApiError("INTERNAL"));
    expect(t.log).toEqual(["stream:status off"]);
    expect(t.session.getView().phase).toBe("live");
    expect(t.session.getView().error).toContain("切換失敗");
    expect(t.transports).toHaveLength(1);
  });

  test("切換途中按停止，停播逾時後仍會停播（重讀意圖）", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    t.session.setIntent(false);
    await t.client.ack("stream:status off", new ApiError("INTERNAL"));
    // 重送的停播還沒確認，本機出流就要先停掉（房主已明確停止）。
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "destroy",
      "stream:status off",
    ]);
    expect(t.session.getView().phase).toBe("stopping");
    await t.client.ack("stream:status off");
    expect(t.log.filter((l) => l === "destroy")).toHaveLength(1);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
  });

  test("切換中再按切換：忽略", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    t.session.setMode("relay");
    expect(t.log).toEqual(["stream:status off"]);
  });

  test.each(["FORBIDDEN", "INTERNAL"] as const)(
    "room:update 明確被拒（%s）：拆掉舊傳輸、顯示錯誤、不呼叫 resync，用原模式重新開播",
    async (code) => {
      const t = setup();
      await t.goLive();
      t.session.setMode("relay");
      await t.client.ack("stream:status off");
      await t.client.ack("room:update mode=relay", new ApiError(code));
      expect(t.log.slice(3)).toEqual(["destroy", "create p2p", "start"]);
      expect(t.log).not.toContain("resync");
      expect(t.session.getView().error).toContain("切換傳送方式失敗");
    },
  );

  test("第 2 步等不到 room:updated 逾時：維持直播暫停中並 resync，新 snapshot 為新模式時依新模式重建並清除錯誤", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "room:update mode=relay",
    ]);

    // 沒收到 room:updated，前進到等待廣播的期限。
    vi.advanceTimersByTime(MODE_UPDATED_TIMEOUT_MS);
    await flush();
    expect(t.log.slice(3)).toEqual(["destroy", "resync"]);
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });
    expect(t.session.getView().error).toContain("切換傳送方式失敗");

    // 等待 resync 期間：再次切模式、改畫質、片源更新、或收到舊連線晚到的 room:updated，都不重建也不送請求。
    t.session.setMode("relay");
    t.session.setQuality("smooth");
    t.session.setSource(readySource(undefined, "新片"));
    t.client.emit(roomUpdated("relay"));
    await flush();
    expect(t.log.slice(3)).toEqual(["destroy", "resync"]);
    expect(t.transports).toHaveLength(1);

    // 新連線驗證成功並回報伺服器實際上已切到 relay：依 snapshot 模式重建開播，並清除逾時錯誤。
    t.connect(snapshot({ mode: "relay" }));
    expect(t.log.slice(5)).toEqual(["create relay", "start"]);
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "starting",
      error: null,
    });

    t.transports[1]!.gate.resolve();
    await flush();
    await t.client.ack("stream:status live 新片");
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "live",
      error: null,
    });
    expect(t.transports[1]!.options.mode).toBe("relay");
  });

  test("第 2 步等不到 room:updated 逾時：新 snapshot 顯示仍在原模式時依原模式重建並告知仍維持原模式", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");

    vi.advanceTimersByTime(MODE_UPDATED_TIMEOUT_MS);
    await flush();
    expect(t.log.slice(3)).toEqual(["destroy", "resync"]);
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });

    // 新連線回報伺服器仍在原模式 p2p。
    t.connect(snapshot({ mode: "p2p" }));
    expect(t.log.slice(5)).toEqual(["create p2p", "start"]);
    expect(t.session.getView().phase).toBe("starting");
    expect(t.session.getView().error).toContain("仍維持原本的傳送方式");
    expect(t.session.getView().error).not.toContain("正在重新連線");

    t.transports[1]!.gate.resolve();
    await flush();
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");
    expect(t.transports[1]!.options.mode).toBe("p2p");
  });

  test("第 2 步 room:update 請求逾時（SignalTimeoutError）：不立即重建、呼叫 resync，收到 snapshot 後依其模式重建", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    await t.client.ack("room:update mode=relay", new SignalTimeoutError());

    expect(t.log.slice(3)).toEqual(["destroy", "resync"]);
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });
    expect(t.session.getView().error).toContain("切換傳送方式失敗");

    t.connect(snapshot({ mode: "relay" }));
    expect(t.log.slice(5)).toEqual(["create relay", "start"]);
    expect(t.session.getView().error).toBeNull();
  });

  test("第 2 步連線中斷（SignalDisconnectedError）：銷毀舊傳輸、不立即重建也不呼叫 resync，自動重連拿到 snapshot 後重建", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    await t.client.ack("room:update mode=relay", new SignalDisconnectedError());

    expect(t.log.slice(3)).toEqual(["destroy"]);
    expect(t.log).not.toContain("resync");
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "waiting",
      error: null,
    });

    t.connect(snapshot({ mode: "relay" }));
    expect(t.log.slice(4)).toEqual(["create relay", "start"]);
  });

  test("等待 resync 期間房主按停止直播：變成 idle，新 snapshot 到來後不自動開播", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    vi.advanceTimersByTime(MODE_UPDATED_TIMEOUT_MS);
    await flush();
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });

    t.session.setIntent(false);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });

    t.connect(snapshot({ mode: "relay" }));
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toEqual({
      intent: false,
      phase: "idle",
      error: null,
    });
  });

  test("等待 resync 期間先按停止再按開始：仍維持 waiting 不提前重建，新 snapshot 到來後才依新模式開播", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    vi.advanceTimersByTime(MODE_UPDATED_TIMEOUT_MS);
    await flush();

    t.session.setIntent(false);
    t.session.setIntent(true);
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "waiting",
      error: null,
    });

    t.connect(snapshot({ mode: "relay" }));
    expect(t.log.slice(5)).toEqual(["create relay", "start"]);
  });

  test("等待 resync 期間片源變成未就緒：新 snapshot 到來不重建，片源就緒後才依 snapshot 模式開播", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    vi.advanceTimersByTime(MODE_UPDATED_TIMEOUT_MS);
    await flush();

    t.session.setSource({ stream: null, status: "idle", title: "" });
    t.connect(snapshot({ mode: "relay" }));
    expect(t.transports).toHaveLength(1);
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "waiting",
      error: null,
    });

    t.session.setSource(readySource());
    expect(t.log.slice(5)).toEqual(["create relay", "start"]);
  });

  test("沒在直播時切模式：只送 room:update", () => {
    const t = setup({ intent: false });
    t.connect();
    t.session.setMode("relay");
    expect(t.log).toEqual(["room:update mode=relay"]);
  });
});
