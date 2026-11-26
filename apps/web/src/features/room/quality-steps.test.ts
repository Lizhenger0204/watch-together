import { DEFAULT_QUALITY, sameQuality } from "@project/shared";
import { describe, expect, test } from "vitest";
import {
  actualSentHeight,
  highResolutionHints,
  isStepSelectable,
  maxNumericHeightIndex,
  qualityButtonLabel,
  stepIndex,
  stepLabel,
  stepValueText,
  withStep,
} from "./quality-steps";

describe("畫質滑桿（streaming.md §2）", () => {
  test("刻度與目前值的文字（含 1440／2160／原片與 25／40 Mbps）", () => {
    expect(stepLabel("height", 900)).toBe("900P");
    expect(stepLabel("height", 1440)).toBe("1440P");
    expect(stepLabel("height", 2160)).toBe("2160P");
    expect(stepLabel("height", "source")).toBe("原片");
    expect(stepLabel("bitrate", 15_000_000)).toBe("15M");
    expect(stepLabel("bitrate", 25_000_000)).toBe("25M");
    expect(stepLabel("bitrate", 40_000_000)).toBe("40M");
    expect(stepLabel("bitrate", "source")).toBe("原片");
    expect(stepLabel("fps", 24)).toBe("24");
    expect(stepValueText("bitrate", 10_000_000, null)).toBe("10 Mbps");
    expect(stepValueText("bitrate", 25_000_000, null)).toBe("25 Mbps");
    expect(stepValueText("bitrate", "source", 23_400_000)).toBe(
      "原片（約 23.4 Mbps）",
    );
    expect(stepValueText("bitrate", "source", null)).toBe("原片");
    expect(stepValueText("fps", 60, null)).toBe("60 FPS");
    expect(stepValueText("height", "source", null, 1608)).toBe("原片（1608P）");
    expect(stepValueText("height", "source", null, 2160)).toBe("原片（2160P）");
    expect(stepValueText("height", "source", null, null)).toBe("原片");
  });

  test("解析度數字檔位不超過片源，「原片」永遠可選；其他滑桿不受片源影響", () => {
    expect(maxNumericHeightIndex(null)).toBe(4);
    expect(maxNumericHeightIndex(2160)).toBe(4);
    expect(maxNumericHeightIndex(1608)).toBe(3);
    expect(maxNumericHeightIndex(1000)).toBe(1);
    expect(maxNumericHeightIndex(720)).toBe(0);
    expect(maxNumericHeightIndex(480)).toBe(-1);

    // 寬銀幕 4K（1608P）：720～1440 可選、2160 停用、原片（index 5）可選
    expect(isStepSelectable("height", 3, 1608)).toBe(true);
    expect(isStepSelectable("height", 4, 1608)).toBe(false);
    expect(isStepSelectable("height", 5, 1608)).toBe(true);

    // 480P 片源：所有數字檔停用，但「原片」仍可選
    expect(isStepSelectable("height", 0, 480)).toBe(false);
    expect(isStepSelectable("height", 5, 480)).toBe(true);
    expect(isStepSelectable("bitrate", 5, 480)).toBe(true);
    expect(isStepSelectable("fps", 3, 480)).toBe(true);
  });

  test("滑桿位置就是房間設定的檔位，不因片源而被夾住", () => {
    expect(stepIndex("height", DEFAULT_QUALITY)).toBe(2);
    expect(stepIndex("height", { ...DEFAULT_QUALITY, height: 2160 })).toBe(4);
    expect(stepIndex("height", { ...DEFAULT_QUALITY, height: "source" })).toBe(
      5,
    );
    expect(stepIndex("bitrate", DEFAULT_QUALITY)).toBe(0);
    expect(
      stepIndex("bitrate", { ...DEFAULT_QUALITY, bitrate: 25_000_000 }),
    ).toBe(3);
    expect(
      stepIndex("bitrate", { ...DEFAULT_QUALITY, bitrate: "source" }),
    ).toBe(5);
    expect(stepIndex("fps", { ...DEFAULT_QUALITY, fps: "source" })).toBe(3);
  });

  test("原片位元率顯示與實際送出的上限一致（最高 50 Mbps）", () => {
    expect(stepValueText("bitrate", "source", 120_000_000)).toBe(
      "原片（約 50 Mbps）",
    );
  });

  test("設定高於片源時，解析度顯示實際送出的片源高度，與可選檔位區分", () => {
    expect(stepValueText("height", 1080, null, 1000)).toBe("1000P（片源）");
    expect(stepValueText("height", 2160, null, 1608)).toBe("1608P（片源）");
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
    // 拉到「原片」（index 5）永遠可選。
    expect(withStep(next, "height", 5, 1000)).toEqual({
      ...DEFAULT_QUALITY,
      height: "source",
    });
  });

  test("片源 720–899P 只有 720P 與原片可選時，仍能從 1080P 設定選到 720P 或原片", () => {
    expect(maxNumericHeightIndex(800)).toBe(0);
    const next = withStep(DEFAULT_QUALITY, "height", 0, 800);
    expect(next).toEqual({ ...DEFAULT_QUALITY, height: 720 });
    expect(sameQuality(next, DEFAULT_QUALITY)).toBe(false);
    expect(withStep(next, "height", 1, 800)).toEqual(next);
    expect(withStep(next, "height", 5, 800)).toEqual({
      ...DEFAULT_QUALITY,
      height: "source",
    });
  });

  test("片源低於 720P 時，拉到停用數字檔保持原設定（已選原片維持原片），拉到原片可選", () => {
    const asSource = withStep(DEFAULT_QUALITY, "height", 5, 480);
    expect(asSource).toEqual({ ...DEFAULT_QUALITY, height: "source" });
    expect(withStep(asSource, "height", 4, 480)).toEqual(asSource);
    expect(withStep(DEFAULT_QUALITY, "height", 0, 480)).toEqual(
      DEFAULT_QUALITY,
    );
  });

  test("寬銀幕 1608P：2160 停用、夾回 1440；原片可選，從原片往左拉跳過 2160 回到 1440", () => {
    const at1440 = withStep(DEFAULT_QUALITY, "height", 3, 1608);
    expect(at1440.height).toBe(1440);
    expect(withStep(at1440, "height", 4, 1608).height).toBe(1440);
    const atSource = withStep(at1440, "height", 5, 1608);
    expect(atSource.height).toBe("source");
    expect(withStep(atSource, "height", 4, 1608).height).toBe(1440);
  });

  test("移動位元率與解析度滑桿得到新畫質", () => {
    expect(withStep(DEFAULT_QUALITY, "bitrate", 3, null)).toEqual({
      ...DEFAULT_QUALITY,
      bitrate: 25_000_000,
    });
    expect(withStep(DEFAULT_QUALITY, "bitrate", 5, null)).toEqual({
      ...DEFAULT_QUALITY,
      bitrate: "source",
    });
    expect(withStep(DEFAULT_QUALITY, "height", 2, 900)).toEqual({
      ...DEFAULT_QUALITY,
      height: 900,
    });
    expect(withStep(DEFAULT_QUALITY, "height", 4, 2160)).toEqual({
      ...DEFAULT_QUALITY,
      height: 2160,
    });
  });

  test("按鈕與實際送出高度顯示", () => {
    expect(actualSentHeight(DEFAULT_QUALITY, 2160)).toBe(1080);
    expect(
      actualSentHeight({ ...DEFAULT_QUALITY, height: "source" }, 1608),
    ).toBe(1608);
    expect(
      actualSentHeight({ ...DEFAULT_QUALITY, height: "source" }, null),
    ).toBe(0);

    expect(qualityButtonLabel(DEFAULT_QUALITY, null)).toBe("1080P");
    expect(qualityButtonLabel(DEFAULT_QUALITY, 2160)).toBe("1080P");
    expect(qualityButtonLabel(DEFAULT_QUALITY, 720)).toBe("720P");
    expect(qualityButtonLabel({ ...DEFAULT_QUALITY, height: 2160 }, 2160)).toBe(
      "2160P",
    );
    expect(
      qualityButtonLabel({ ...DEFAULT_QUALITY, height: "source" }, 1608),
    ).toBe("原片（1608P）");
    expect(
      qualityButtonLabel({ ...DEFAULT_QUALITY, height: "source" }, 2160),
    ).toBe("原片（2160P）");
    expect(
      qualityButtonLabel({ ...DEFAULT_QUALITY, height: "source" }, null),
    ).toBe("原片");
  });

  test("高畫質靜態提示與位元率提示（streaming.md §2）", () => {
    const src4k = { height: 2160, bitrate: 30_000_000 };
    const src1080 = { height: 1080, bitrate: 10_000_000 };

    // 1080P 不顯示高畫質提示
    expect(highResolutionHints(DEFAULT_QUALITY, src4k, "p2p", 3)).toEqual({
      showStaticHint: false,
      warnStaticHint: false,
      showBitrateHint: false,
    });

    // 1440P：顯示靜態提示、不顯示 4K 位元率提示；P2P ≥ 2 人用警告樣式，轉發不用
    const q1440 = { ...DEFAULT_QUALITY, height: 1440 } as const;
    expect(highResolutionHints(q1440, src4k, "p2p", 1)).toEqual({
      showStaticHint: true,
      warnStaticHint: false,
      showBitrateHint: false,
    });
    expect(highResolutionHints(q1440, src4k, "p2p", 2)).toEqual({
      showStaticHint: true,
      warnStaticHint: true,
      showBitrateHint: false,
    });
    expect(highResolutionHints(q1440, src4k, "relay", 5)).toEqual({
      showStaticHint: true,
      warnStaticHint: false,
      showBitrateHint: false,
    });

    // 2160P：< 25 Mbps 顯示位元率提示，≥ 25 Mbps 不顯示
    expect(
      highResolutionHints(
        { height: 2160, bitrate: 15_000_000, fps: 30 },
        src4k,
        "p2p",
        1,
      ),
    ).toEqual({
      showStaticHint: true,
      warnStaticHint: false,
      showBitrateHint: true,
    });
    expect(
      highResolutionHints(
        { height: 2160, bitrate: 25_000_000, fps: 30 },
        src4k,
        "p2p",
        1,
      ),
    ).toEqual({
      showStaticHint: true,
      warnStaticHint: false,
      showBitrateHint: false,
    });

    // 1080P 片源設定 2160P：實際送出高度只有 1080，不顯示高畫質提示
    expect(
      highResolutionHints(
        { height: 2160, bitrate: 8_000_000, fps: 30 },
        src1080,
        "p2p",
        3,
      ),
    ).toEqual({
      showStaticHint: false,
      warnStaticHint: false,
      showBitrateHint: false,
    });

    // 寬銀幕 1608P + 原片解析度 + 原片位元率 18 Mbps：超過 1440 且 < 25M
    expect(
      highResolutionHints(
        { height: "source", bitrate: "source", fps: 30 },
        { height: 1608, bitrate: 18_000_000 },
        "p2p",
        2,
      ),
    ).toEqual({
      showStaticHint: true,
      warnStaticHint: true,
      showBitrateHint: true,
    });
  });
});
