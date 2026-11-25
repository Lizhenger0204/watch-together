import { TITLE_MAX_LENGTH } from "@project/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fallbackGraphemes, streamTitle } from "./live-intent";

describe("streamTitle", () => {
  test("不切斷 emoji 等兩個 UTF-16 單位的字元", () => {
    const title = streamTitle("a".repeat(TITLE_MAX_LENGTH - 1) + "🎬🎬");
    expect(title).toBe("a".repeat(TITLE_MAX_LENGTH - 1));
  });

  test.each([
    ["ZWJ 家庭", "👨‍👩‍👧‍👦"],
    ["膚色", "👍🏽"],
    ["旗幟", "🇹🇼"],
    ["組合字元", "e\u0301"],
  ])("不切斷組合字素（%s）", (_name, cluster) => {
    const prefix = "a".repeat(TITLE_MAX_LENGTH - cluster.length + 1);
    const title = streamTitle(prefix + cluster)!;
    expect(title).toBe(prefix);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });

  test("組合 emoji 剛好放得下就保留整個", () => {
    const cluster = "👨‍👩‍👧‍👦";
    const prefix = "a".repeat(TITLE_MAX_LENGTH - cluster.length);
    expect(streamTitle(prefix + cluster + "b")).toBe(prefix + cluster);
  });

  test("片名超過上限時截斷", () => {
    expect(streamTitle("b".repeat(TITLE_MAX_LENGTH + 10))).toBe(
      "b".repeat(TITLE_MAX_LENGTH),
    );
  });

  test("空白片名送 null", () => {
    expect(streamTitle("  ")).toBeNull();
  });
});

describe("沒有 Intl.Segmenter 的瀏覽器", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test("載入模組不會拋錯，片名仍能截斷", async () => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    vi.resetModules();
    const mod = await import("./live-intent");
    expect(mod.streamTitle("  電影  ")).toBe("電影");
    const cluster = "👨‍👩‍👧‍👦";
    const prefix = "a".repeat(TITLE_MAX_LENGTH - cluster.length + 1);
    expect(mod.streamTitle(prefix + cluster)).toBe(prefix);
  });

  test.each([
    ["ZWJ 家庭", "👨‍👩‍👧‍👦"],
    ["膚色", "👍🏽"],
    ["旗幟", "🇹🇼"],
    ["組合字元", "e\u0301"],
    ["變體選擇符", "❤️"],
  ])("後備切法把整個字素當一個（%s）", (_name, cluster) => {
    expect(fallbackGraphemes(`a${cluster}b`)).toEqual(["a", cluster, "b"]);
  });

  test("兩面國旗相鄰時各自成對", () => {
    expect(fallbackGraphemes("🇹🇼🇯🇵")).toEqual(["🇹🇼", "🇯🇵"]);
  });
});
