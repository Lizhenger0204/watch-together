import { DEFAULT_QUALITY, sameQuality } from "@project/shared";
import { describe, expect, test } from "vitest";
import {
  maxStepIndex,
  qualityButtonLabel,
  stepIndex,
  stepLabel,
  stepValueText,
  withStep,
} from "./quality-steps";

describe("畫質滑桿（streaming.md §2）", () => {
  test("刻度與目前值的文字", () => {
    expect(stepLabel("height", 900)).toBe("900P");
    expect(stepLabel("bitrate", 15_000_000)).toBe("15M");
    expect(stepLabel("bitrate", "source")).toBe("原片");
    expect(stepLabel("fps", 24)).toBe("24");
    expect(stepValueText("bitrate", 10_000_000, null)).toBe("10 Mbps");
    expect(stepValueText("bitrate", "source", 23_400_000)).toBe(
      "原片（約 23.4 Mbps）",
    );
    expect(stepValueText("bitrate", "source", null)).toBe("原片");
    expect(stepValueText("fps", 60, null)).toBe("60 FPS");
  });

  test("解析度不超過片源；其他滑桿不受片源影響", () => {
    expect(maxStepIndex("height", null)).toBe(2);
    expect(maxStepIndex("height", 2160)).toBe(2);
    expect(maxStepIndex("height", 1000)).toBe(1);
    expect(maxStepIndex("height", 720)).toBe(0);
    expect(maxStepIndex("height", 480)).toBe(-1);
    expect(maxStepIndex("fps", 480)).toBe(3);
  });

  test("滑桿位置就是房間設定的檔位，不因片源而被夾住", () => {
    expect(stepIndex("height", DEFAULT_QUALITY)).toBe(2);
    expect(stepIndex("bitrate", DEFAULT_QUALITY)).toBe(0);
    expect(stepIndex("fps", { ...DEFAULT_QUALITY, fps: "source" })).toBe(3);
  });

  test("原片位元率顯示與實際送出的上限一致（最高 50 Mbps）", () => {
    expect(stepValueText("bitrate", "source", 120_000_000)).toBe(
      "原片（約 50 Mbps）",
    );
  });

  test("設定高於片源時，解析度顯示實際送出的片源高度，與可選檔位區分", () => {
    expect(stepValueText("height", 1080, null, 1000)).toBe("1000P（片源）");
    expect(stepValueText("height", 900, null, 1000)).toBe("900P");
    expect(stepValueText("height", 1080, null, 2160)).toBe("1080P");
    expect(stepValueText("height", 1080, null, null)).toBe("1080P");
  });

  // 使用者操作：1000P 片源、房間設定 1080P（預設）。滑桿停在 1080P，往左拉到 900P 時
  // 瀏覽器送出 change（index 2 → 1），面板必須得到一個與房間設定不同、可提交的畫質。
  test("1000P 片源、設定 1080P 時，直接選 900P 得到可提交的新畫質", () => {
    const from = stepIndex("height", DEFAULT_QUALITY);
    expect(from).toBe(2);
    const next = withStep(DEFAULT_QUALITY, "height", from - 1, 1000);
    expect(next).toEqual({ ...DEFAULT_QUALITY, height: 900 });
    expect(sameQuality(next, DEFAULT_QUALITY)).toBe(false);
    // 往右拉到不可選的 1080P 會被夾回 900P，不會變成高於片源的檔位。
    expect(withStep(next, "height", 2, 1000)).toEqual(next);
  });

  test("片源 720–899P 只有 720P 可選時，仍能從 1080P 設定選到 720P", () => {
    expect(maxStepIndex("height", 800)).toBe(0);
    const next = withStep(DEFAULT_QUALITY, "height", 0, 800);
    expect(next).toEqual({ ...DEFAULT_QUALITY, height: 720 });
    expect(sameQuality(next, DEFAULT_QUALITY)).toBe(false);
    expect(withStep(next, "height", 1, 800)).toEqual(next);
  });

  test("移動滑桿得到新畫質，超出片源時夾住", () => {
    expect(withStep(DEFAULT_QUALITY, "bitrate", 3, null)).toEqual({
      ...DEFAULT_QUALITY,
      bitrate: "source",
    });
    expect(withStep(DEFAULT_QUALITY, "height", 2, 900)).toEqual({
      ...DEFAULT_QUALITY,
      height: 900,
    });
  });

  test("按鈕顯示實際送出的解析度", () => {
    expect(qualityButtonLabel(DEFAULT_QUALITY, null)).toBe("1080P");
    expect(qualityButtonLabel(DEFAULT_QUALITY, 2160)).toBe("1080P");
    expect(qualityButtonLabel(DEFAULT_QUALITY, 720)).toBe("720P");
  });
});
