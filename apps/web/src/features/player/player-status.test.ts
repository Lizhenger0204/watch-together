import { describe, expect, test } from "vitest";
import { playerStatus, type PlayerStatusInput } from "./player-status";

const base: PlayerStatusInput = {
  live: true,
  state: "connecting",
  errorMessage: null,
  hostName: "小明",
  hostOnline: true,
};

describe("playerStatus", () => {
  test("未開播：等待房主；房主離線時說明", () => {
    expect(playerStatus({ ...base, live: false }).text).toBe(
      "等待 小明 開始播放…",
    );
    expect(playerStatus({ ...base, live: false, hostOnline: false }).text).toBe(
      "房主目前離線，等待房主回來…",
    );
    expect(
      playerStatus({
        ...base,
        live: false,
        hostOnline: false,
        hostPresent: false,
      }),
    ).toEqual({
      text: "房主已離開房間。",
      tone: "info",
      reconnect: false,
    });
  });

  test.each([
    ["waiting", "連線中…"],
    ["connecting", "連線中…"],
    ["buffering", "緩衝中…"],
    ["playing", null],
  ] as const)("直播中 %s → %s", (state, text) => {
    expect(playerStatus({ ...base, state })).toMatchObject({
      text,
      reconnect: false,
    });
  });

  test("失敗：顯示原因與重新連線按鈕", () => {
    expect(
      playerStatus({ ...base, state: "failed", errorMessage: "等不到房主" }),
    ).toEqual({ text: "等不到房主", tone: "error", reconnect: true });
    expect(playerStatus({ ...base, state: "failed" }).text).toBe("連線失敗。");
  });
});
