import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ENCODER_LAG_DURATION_MS,
  EncoderHealthTracker,
  checkEncoderClear,
  initialEncoderHealth,
  isSampleLagging,
  recordEncoderSample,
  removeEncoderSender,
  targetFramerate,
} from "./encoder-health";
import { browserTimers } from "./host-session-types";

afterEach(() => vi.useRealTimers());

describe("encoder-health（streaming.md §2「編碼跟不上」）", () => {
  test("目標幀率：取 min(maxFramerate, 片源 FPS)，只量到一個用那一個，都量不到回 null", () => {
    expect(targetFramerate(60, 24)).toBe(24);
    expect(targetFramerate(24, 30)).toBe(24);
    expect(targetFramerate(30, 60)).toBe(30);
    expect(targetFramerate(30, undefined)).toBe(30);
    expect(targetFramerate(30, null)).toBe(30);
    expect(targetFramerate(30, 0)).toBe(30);
    expect(targetFramerate(null, 30)).toBe(30);
    expect(targetFramerate(null, 24)).toBe(24);
    expect(targetFramerate(null, undefined)).toBeNull();
    expect(targetFramerate(null, null)).toBeNull();
    expect(targetFramerate(null, 0)).toBeNull();
    expect(targetFramerate(null, Number.NaN)).toBeNull();
  });

  test("FPS 目標規則（片源與設定組合）：避免 24 FPS 片設 60 誤報，其餘低於目標 70% 連續 10 秒才報", () => {
    const runTenSeconds = (
      maxFramerate: number | null,
      sourceFps: number | null | undefined,
      sentFps: number,
      reason: "none" | "cpu" = "none",
    ) => {
      const targetFps = targetFramerate(maxFramerate, sourceFps);
      let state = initialEncoderHealth();
      for (let t = 0; t <= ENCODER_LAG_DURATION_MS; t += 2_000) {
        state = recordEncoderSample(state, {
          senderId: "v1",
          stats: { framesPerSecond: sentFps, qualityLimitationReason: reason },
          targetFps,
          now: t,
        });
      }
      return state.lagging;
    };

    // 片源 24、設定 60、送出 24 → 目標 24，不報（避免誤報）
    expect(runTenSeconds(60, 24, 24)).toBe(false);
    // 片源 30、設定 24、送出 15 → 目標 24（70% 為 16.8），報；送出 17 不報
    expect(runTenSeconds(24, 30, 15)).toBe(true);
    expect(runTenSeconds(24, 30, 17)).toBe(false);
    // 片源未知、設定 30、送出 15 → 目標 30（70% 為 21），報
    expect(runTenSeconds(30, undefined, 15)).toBe(true);
    expect(runTenSeconds(30, null, 15)).toBe(true);
    // 原片 FPS（null）、片源 30、送出 15 → 目標 30，報
    expect(runTenSeconds(null, 30, 15)).toBe(true);
    // 兩者都未知 → 不判斷 FPS，只看 cpu
    expect(runTenSeconds(null, undefined, 15, "none")).toBe(false);
    expect(runTenSeconds(null, undefined, 15, "cpu")).toBe(true);
  });

  test("單次取樣條件：CPU 受限、送出 FPS < 目標 70%；剛好 70% 或量不到 FPS 不觸發", () => {
    expect(isSampleLagging({ qualityLimitationReason: "cpu" }, null)).toBe(
      true,
    );
    expect(
      isSampleLagging(
        { qualityLimitationReason: "bandwidth", framesPerSecond: 30 },
        30,
      ),
    ).toBe(false);
    // 30 * 0.7 = 21：低於 21 才算跟不上，剛好 21 不算
    expect(isSampleLagging({ framesPerSecond: 20.9 }, 30)).toBe(true);
    expect(isSampleLagging({ framesPerSecond: 21 }, 30)).toBe(false);
    expect(isSampleLagging({ framesPerSecond: 0 }, 30)).toBe(true);
    // 量不到送出 FPS 或目標 FPS 時不判斷 FPS 條件
    expect(isSampleLagging({ framesPerSecond: 5 }, null)).toBe(false);
    expect(isSampleLagging({ qualityLimitationReason: "none" }, 30)).toBe(
      false,
    );
  });

  test("剛好連續 10 秒才觸發（9999 ms 不觸發，10000 ms 觸發）", () => {
    let state = initialEncoderHealth();
    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: { qualityLimitationReason: "cpu" },
      targetFps: 30,
      now: 1_000,
    });
    expect(state.lagging).toBe(false);

    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: { qualityLimitationReason: "cpu" },
      targetFps: 30,
      now: 1_000 + ENCODER_LAG_DURATION_MS - 1,
    });
    expect(state.lagging).toBe(false);

    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: { qualityLimitationReason: "cpu" },
      targetFps: 30,
      now: 1_000 + ENCODER_LAG_DURATION_MS,
    });
    expect(state.lagging).toBe(true);
  });

  test("中途恢復會重新計時，不會把兩段短暫跟不上累加起來", () => {
    let state = initialEncoderHealth();
    const lowFps = {
      framesPerSecond: 15,
      qualityLimitationReason: "none",
    } as const;
    const ok = {
      framesPerSecond: 30,
      qualityLimitationReason: "none",
    } as const;

    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: lowFps,
      targetFps: 30,
      now: 0,
    });
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: lowFps,
      targetFps: 30,
      now: 8_000,
    });
    expect(state.lagging).toBe(false);

    // 恢復一次，計時歸零
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: ok,
      targetFps: 30,
      now: 9_000,
    });
    expect(state.lagging).toBe(false);

    // 重新開始跟不上：從 10_000 起算，滿 10 秒才觸發
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: lowFps,
      targetFps: 30,
      now: 10_000,
    });
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: lowFps,
      targetFps: 30,
      now: 19_999,
    });
    expect(state.lagging).toBe(false);

    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: lowFps,
      targetFps: 30,
      now: 20_000,
    });
    expect(state.lagging).toBe(true);
  });

  test("P2P 多位收看者：任一人連續 10 秒即觸發，其他人的正常樣本不干擾計時", () => {
    let state = initialEncoderHealth();
    const cpu = {
      qualityLimitationReason: "cpu",
      framesPerSecond: 18,
    } as const;
    const ok = {
      qualityLimitationReason: "none",
      framesPerSecond: 30,
    } as const;

    for (let t = 0; t <= 8_000; t += 2_000) {
      state = recordEncoderSample(state, {
        senderId: "v1",
        stats: ok,
        targetFps: 30,
        now: t,
      });
      state = recordEncoderSample(state, {
        senderId: "v2",
        stats: cpu,
        targetFps: 30,
        now: t + 1_000,
      });
      expect(state.lagging).toBe(false);
    }

    // v1 正常不影響 v2 的計時；v2 在 t = 11_000 剛好滿 10 秒觸發
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: ok,
      targetFps: 30,
      now: 10_000,
    });
    expect(state.lagging).toBe(false);

    state = recordEncoderSample(state, {
      senderId: "v2",
      stats: cpu,
      targetFps: 30,
      now: 11_000,
    });
    expect(state.lagging).toBe(true);

    // 只要 v2 還在跟不上，v1 持續正常 20 秒也不會清除提示
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: ok,
      targetFps: 30,
      now: 31_000,
    });
    expect(state.lagging).toBe(true);

    // v2 恢復後開始 10 秒清除計時
    state = recordEncoderSample(state, {
      senderId: "v2",
      stats: ok,
      targetFps: 30,
      now: 32_000,
    });
    expect(state.lagging).toBe(true);
    state = recordEncoderSample(state, {
      senderId: "v2",
      stats: ok,
      targetFps: 30,
      now: 41_999,
    });
    expect(state.lagging).toBe(true);
    state = recordEncoderSample(state, {
      senderId: "v2",
      stats: ok,
      targetFps: 30,
      now: 42_000,
    });
    expect(state.lagging).toBe(false);
  });

  test("清除期間再次跟不上會重設清除計時", () => {
    let state = initialEncoderHealth();
    const cpu = { qualityLimitationReason: "cpu" } as const;
    const ok = {
      qualityLimitationReason: "none",
      framesPerSecond: 30,
    } as const;

    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: cpu,
      targetFps: 30,
      now: 0,
    });
    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: cpu,
      targetFps: 30,
      now: 10_000,
    });
    expect(state.lagging).toBe(true);

    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: ok,
      targetFps: 30,
      now: 12_000,
    });
    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: cpu,
      targetFps: 30,
      now: 18_000,
    });
    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: ok,
      targetFps: 30,
      now: 20_000,
    });
    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: ok,
      targetFps: 30,
      now: 29_999,
    });
    expect(state.lagging).toBe(true);
    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: ok,
      targetFps: 30,
      now: 30_000,
    });
    expect(state.lagging).toBe(false);
  });

  test("量不到目標 FPS 或送出 FPS 時不判斷 FPS 條件，但 CPU 條件仍生效", () => {
    let state = initialEncoderHealth();
    for (let t = 0; t <= 20_000; t += 2_000) {
      state = recordEncoderSample(state, {
        senderId: "relay",
        stats: { framesPerSecond: 5, qualityLimitationReason: "none" },
        targetFps: null,
        now: t,
      });
    }
    expect(state.lagging).toBe(false);

    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: { qualityLimitationReason: "cpu" },
      targetFps: null,
      now: 22_000,
    });
    state = recordEncoderSample(state, {
      senderId: "relay",
      stats: { qualityLimitationReason: "cpu" },
      targetFps: null,
      now: 32_000,
    });
    expect(state.lagging).toBe(true);
  });

  test("移除唯一跟不上的收看者後滿 10 秒自動清除（無新樣本也能靠假時鐘清除）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const changed = vi.fn();
    const tracker = new EncoderHealthTracker({
      timers: browserTimers,
      now: () => Date.now(),
      changed,
    });

    tracker.observe("v1", { qualityLimitationReason: "cpu" }, 30);
    vi.advanceTimersByTime(ENCODER_LAG_DURATION_MS);
    tracker.observe("v1", { qualityLimitationReason: "cpu" }, 30);
    expect(tracker.lagging).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);

    tracker.removeSender("v1");
    expect(tracker.lagging).toBe(true);

    vi.advanceTimersByTime(ENCODER_LAG_DURATION_MS - 1);
    expect(tracker.lagging).toBe(true);

    vi.advanceTimersByTime(1);
    expect(tracker.lagging).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  test("reset（停播或換畫質）立即清除並作廢先前的累計", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const changed = vi.fn();
    const tracker = new EncoderHealthTracker({
      timers: browserTimers,
      now: () => Date.now(),
      changed,
    });

    tracker.observe("relay", { qualityLimitationReason: "cpu" }, 30);
    vi.advanceTimersByTime(ENCODER_LAG_DURATION_MS);
    tracker.observe("relay", { qualityLimitationReason: "cpu" }, 30);
    expect(tracker.lagging).toBe(true);

    tracker.reset();
    expect(tracker.lagging).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);

    // 檢查純函式 checkEncoderClear 與 removeEncoderSender 的邊界
    let state = initialEncoderHealth();
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: { qualityLimitationReason: "cpu" },
      targetFps: 30,
      now: 0,
    });
    state = recordEncoderSample(state, {
      senderId: "v1",
      stats: { qualityLimitationReason: "cpu" },
      targetFps: 30,
      now: 10_000,
    });
    state = removeEncoderSender(state, "v1", 12_000);
    expect(checkEncoderClear(state, 21_999).lagging).toBe(true);
    expect(checkEncoderClear(state, 22_000).lagging).toBe(false);
  });
});
