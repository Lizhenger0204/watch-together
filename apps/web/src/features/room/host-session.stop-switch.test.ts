import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { MODE_UPDATED_TIMEOUT_MS } from "./host-session-base";
import { flush, roomUpdated, setup } from "./host-session.fixtures";

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

  test("room:update 被拒：拆掉舊傳輸、顯示錯誤，用原模式重新開播", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    await t.client.ack("room:update mode=relay", new ApiError("FORBIDDEN"));
    expect(t.log.slice(3)).toEqual(["destroy", "create p2p", "start"]);
    expect(t.session.getView().error).toContain("切換傳送方式失敗");
  });

  test("第 2 步等不到 room:updated 廣播：逾時後用原模式重建並顯示錯誤", async () => {
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
    expect(t.log.slice(-3)).toEqual(["destroy", "create p2p", "start"]);
    expect(t.session.getView().error).toContain("切換傳送方式失敗");
  });

  test("沒在直播時切模式：只送 room:update", () => {
    const t = setup({ intent: false });
    t.connect();
    t.session.setMode("relay");
    expect(t.log).toEqual(["room:update mode=relay"]);
  });
});
