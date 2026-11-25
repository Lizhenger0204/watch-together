import { describe, expect, test } from "vitest";
import {
  DEFAULT_QUALITY,
  SOURCE_BITRATE_FALLBACK,
  SOURCE_BITRATE_MAX,
  estimateSourceBitrate,
  parseStoredQuality,
  qualitySchema,
  resolveQuality,
  sameQuality,
} from "../src";

describe("畫質檔位（streaming.md §2）", () => {
  test("預設畫質是合法檔位：1080P、8 Mbps、30 FPS", () => {
    expect(qualitySchema.parse(DEFAULT_QUALITY)).toEqual({
      height: 1080,
      bitrate: 8_000_000,
      fps: 30,
    });
  });

  test("固定檔位直接對應編碼參數", () => {
    expect(
      resolveQuality({ height: 720, bitrate: 10_000_000, fps: 60 }, 40e6),
    ).toEqual({ targetHeight: 720, maxBitrate: 10_000_000, maxFramerate: 60 });
  });

  test("原片 FPS 不限制幀率", () => {
    expect(
      resolveQuality({ height: 900, bitrate: 8_000_000, fps: "source" }, null)
        .maxFramerate,
    ).toBeNull();
  });

  test("原片位元率：用估計值，超過上限時夾住，量不到時用後備值", () => {
    const q = { height: 1080, bitrate: "source", fps: 30 } as const;
    expect(resolveQuality(q, 12_345_678).maxBitrate).toBe(12_345_678);
    expect(resolveQuality(q, 80_000_000).maxBitrate).toBe(SOURCE_BITRATE_MAX);
    expect(resolveQuality(q, null).maxBitrate).toBe(SOURCE_BITRATE_FALLBACK);
  });

  test("由檔案大小與片長估計原片位元率", () => {
    // 1 GB、100 分鐘 ≈ 1.43 Mbps
    expect(estimateSourceBitrate(1_073_741_824, 6000)).toBe(1_431_656);
    expect(estimateSourceBitrate(1000, 0)).toBeNull();
    expect(estimateSourceBitrate(1000, Number.NaN)).toBeNull();
    expect(estimateSourceBitrate(1000, Number.POSITIVE_INFINITY)).toBeNull();
    expect(estimateSourceBitrate(0, 10)).toBeNull();
  });

  test("比較兩個畫質", () => {
    expect(sameQuality(DEFAULT_QUALITY, { ...DEFAULT_QUALITY })).toBe(true);
    expect(sameQuality(DEFAULT_QUALITY, { ...DEFAULT_QUALITY, fps: 60 })).toBe(
      false,
    );
  });

  test("讀取舊房間存的預設名稱時回到預設畫質", () => {
    expect(parseStoredQuality("standard")).toEqual(DEFAULT_QUALITY);
    expect(parseStoredQuality(undefined)).toEqual(DEFAULT_QUALITY);
    const stored = { height: 720, bitrate: "source", fps: 24 };
    expect(parseStoredQuality(stored)).toEqual(stored);
  });
});
