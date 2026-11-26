import { describe, expect, test } from "vitest";
import {
  DEFAULT_QUALITY,
  HIGH_RESOLUTION_BITRATE_HINT,
  HIGH_RESOLUTION_HINT_ABOVE_HEIGHT,
  MAINTAIN_RESOLUTION_ABOVE_HEIGHT,
  SOURCE_BITRATE_FALLBACK,
  SOURCE_BITRATE_MAX,
  estimateSourceBitrate,
  parseStoredQuality,
  qualitySchema,
  resolveQuality,
  sameQuality,
  sentVideoHeight,
  videoEncodingPolicy,
} from "../src";

describe("畫質檔位（streaming.md §2）", () => {
  test("預設畫質是合法檔位：1080P、8 Mbps、30 FPS", () => {
    expect(qualitySchema.parse(DEFAULT_QUALITY)).toEqual({
      height: 1080,
      bitrate: 8_000_000,
      fps: 30,
    });
  });

  test("qualitySchema 接受 1440／2160／原片解析度與 25／40 Mbps，拒絕非檔位值與多餘欄位", () => {
    for (const quality of [
      { height: 1440, bitrate: 25_000_000, fps: 30 },
      { height: 2160, bitrate: 40_000_000, fps: 60 },
      { height: "source", bitrate: "source", fps: "source" },
    ]) {
      expect(qualitySchema.parse(quality)).toEqual(quality);
    }

    expect(
      qualitySchema.safeParse({ height: 1200, bitrate: 8_000_000, fps: 30 })
        .success,
    ).toBe(false);
    expect(
      qualitySchema.safeParse({ height: 1080, bitrate: 20_000_000, fps: 30 })
        .success,
    ).toBe(false);
    expect(
      qualitySchema.safeParse({ height: 1080, bitrate: 8_000_000, fps: 45 })
        .success,
    ).toBe(false);
    expect(
      qualitySchema.safeParse({ ...DEFAULT_QUALITY, extra: true }).success,
    ).toBe(false);
  });

  test("固定檔位直接對應編碼參數（含 1440／2160 與 25／40 Mbps）", () => {
    expect(
      resolveQuality({ height: 720, bitrate: 10_000_000, fps: 60 }, 40e6),
    ).toEqual({ targetHeight: 720, maxBitrate: 10_000_000, maxFramerate: 60 });
    expect(
      resolveQuality({ height: 1440, bitrate: 25_000_000, fps: 30 }, 40e6),
    ).toEqual({ targetHeight: 1440, maxBitrate: 25_000_000, maxFramerate: 30 });
    expect(
      resolveQuality({ height: 2160, bitrate: 40_000_000, fps: 60 }, 40e6),
    ).toEqual({ targetHeight: 2160, maxBitrate: 40_000_000, maxFramerate: 60 });
  });

  test("原片解析度回傳 targetHeight: null（不縮放）", () => {
    expect(
      resolveQuality({ height: "source", bitrate: 25_000_000, fps: 30 }, null),
    ).toEqual({
      targetHeight: null,
      maxBitrate: 25_000_000,
      maxFramerate: 30,
    });
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

  test("sentVideoHeight 與 videoEncodingPolicy：縮放與降級策略（ADR 0004 D3）", () => {
    expect(MAINTAIN_RESOLUTION_ABOVE_HEIGHT).toBe(1080);
    expect(HIGH_RESOLUTION_HINT_ABOVE_HEIGHT).toBe(1440);
    expect(HIGH_RESOLUTION_BITRATE_HINT).toBe(25_000_000);

    // 不超過片源：2160 檔 + 1608 片源 → 不縮放、實際送 1608、maintain-resolution
    expect(sentVideoHeight(1608, 2160)).toBe(1608);
    expect(videoEncodingPolicy(1608, 2160)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-resolution",
    });

    // 原片不縮放：> 1080 用 maintain-resolution，≤ 1080 維持 maintain-framerate
    expect(sentVideoHeight(2160, null)).toBe(2160);
    expect(videoEncodingPolicy(2160, null)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-resolution",
    });
    expect(sentVideoHeight(1608, null)).toBe(1608);
    expect(videoEncodingPolicy(1608, null)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-resolution",
    });
    expect(sentVideoHeight(1080, null)).toBe(1080);
    expect(videoEncodingPolicy(1080, null)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-framerate",
    });

    // 4K 片源縮到 1440／1080
    expect(sentVideoHeight(2160, 1440)).toBe(1440);
    expect(videoEncodingPolicy(2160, 1440)).toEqual({
      scaleResolutionDownBy: 1.5,
      degradationPreference: "maintain-resolution",
    });
    expect(sentVideoHeight(2160, 1080)).toBe(1080);
    expect(videoEncodingPolicy(2160, 1080)).toEqual({
      scaleResolutionDownBy: 2,
      degradationPreference: "maintain-framerate",
    });

    // 1080 片源選 2160：實際送 1080，不改 maintain-resolution
    expect(sentVideoHeight(1080, 2160)).toBe(1080);
    expect(videoEncodingPolicy(1080, 2160)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-framerate",
    });

    // 片源高度未知（0 或負值）：不縮放；有數字目標時依目標高度判降級策略，原片時回 0
    expect(sentVideoHeight(0, 2160)).toBe(2160);
    expect(videoEncodingPolicy(0, 2160)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-resolution",
    });
    expect(sentVideoHeight(0, 1080)).toBe(1080);
    expect(videoEncodingPolicy(0, 1080)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-framerate",
    });
    expect(sentVideoHeight(0, null)).toBe(0);
    expect(videoEncodingPolicy(0, null)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-framerate",
    });
    expect(sentVideoHeight(-1, 1440)).toBe(1440);
    expect(videoEncodingPolicy(-1, 1440)).toEqual({
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-resolution",
    });
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
