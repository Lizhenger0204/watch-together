import { afterEach, expect, test, vi } from "vitest";
import { ENCODER_LAG_DURATION_MS } from "./encoder-health";
import { roomUpdated, setup } from "./host-session.fixtures";

// Safari 模式（streaming.md §2）：只在房主本機生效，不送 room:update、不重建傳輸。

afterEach(() => vi.useRealTimers());

test("直播中切換：只呼叫現有傳輸的 setSafariMode，不送請求也不重建；畫面反映開關", async () => {
  const t = setup();
  const transport = await t.goLive();
  expect(t.session.getView().safariMode).toBe(false);

  t.session.setSafariMode(true);
  expect(t.log).toEqual(["setSafariMode true"]);
  expect(t.session.getView().safariMode).toBe(true);
  expect(t.transports).toEqual([transport]);

  // 重複設定相同值不再呼叫。
  t.session.setSafariMode(true);
  expect(t.log).toEqual(["setSafariMode true"]);
});

test("未開播時切換：之後建立的傳輸帶入目前設定；切模式重建也沿用", async () => {
  const t = setup();
  t.session.setSafariMode(true);
  await t.goLive();
  expect(t.transports[0]!.options.safariMode).toBe(true);

  t.session.setMode("relay");
  await t.client.ack("stream:status off");
  t.client.emit(roomUpdated("relay"));
  await vi.waitFor(() => expect(t.transports).toHaveLength(2));
  expect(t.transports[1]!.options.safariMode).toBe(true);
});

test("切換時重新計算「編碼跟不上」", async () => {
  vi.useFakeTimers();
  const t = setup();
  const transport = await t.goLive();
  const cpu = {
    memberId: "v1",
    bitrateKbps: 8_000,
    qualityLimitationReason: "cpu" as const,
  };
  transport.emitStats(cpu);
  vi.advanceTimersByTime(ENCODER_LAG_DURATION_MS);
  transport.emitStats(cpu);
  expect(t.session.getView().encoderLagging).toBe(true);

  t.session.setSafariMode(true);
  expect(t.session.getView().encoderLagging).toBe(false);
});
