import { DEFAULT_QUALITY } from "@project/shared";
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

  test("目前檔位超過片源時顯示在最高可選檔位", () => {
    expect(stepIndex("height", DEFAULT_QUALITY, null)).toBe(2);
    expect(stepIndex("height", DEFAULT_QUALITY, 720)).toBe(0);
    expect(stepIndex("bitrate", DEFAULT_QUALITY, 720)).toBe(0);
    expect(stepIndex("fps", { ...DEFAULT_QUALITY, fps: "source" }, null)).toBe(
      3,
    );
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
