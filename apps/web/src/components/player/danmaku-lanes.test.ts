import { describe, expect, test } from "vitest";
import {
  DANMAKU_GAP_PX,
  DanmakuScheduler,
  earliestFollowStart,
  estimateDanmakuDurationMs,
  laneBand,
  laneTopPercent,
  presetForDensity,
  type DanmakuDensity,
  type DanmakuScheduleResult,
} from "./danmaku-lanes";

function place(
  scheduler: DanmakuScheduler,
  id: string,
  opts: {
    density?: DanmakuDensity;
    now?: number;
    activeCount?: number;
    isSelf?: boolean;
    text?: string;
    textWidth?: number;
    stageWidth?: number;
  } = {},
): DanmakuScheduleResult {
  return scheduler.schedule({
    id,
    text: opts.text ?? "你好",
    density: opts.density ?? "low",
    activeCount: opts.activeCount ?? 0,
    now: opts.now ?? 1000,
    isSelf: opts.isSelf ?? false,
    textWidth: opts.textWidth ?? 40,
    stageWidth: opts.stageWidth ?? 960,
  });
}

const topOf = (result: DanmakuScheduleResult) =>
  result.kind === "placed" ? result.item.topPercent : null;

describe("DanmakuScheduler", () => {
  test("同時抵達的彈幕分配到不同軌道", () => {
    const scheduler = new DanmakuScheduler();
    const tops = ["m0", "m1", "m2"].map((id) => topOf(place(scheduler, id)));
    expect(tops).toEqual([0, 1, 2].map((lane) => laneTopPercent(lane, "low")));
  });

  test("軌道全滿時不疊在同一位置，而是回報最早可重試的時間", () => {
    const scheduler = new DanmakuScheduler();
    for (const id of ["m0", "m1", "m2"]) place(scheduler, id);
    const fourth = place(scheduler, "m3");
    expect(fourth.kind).toBe("wait");
    if (fourth.kind !== "wait") return;
    expect(fourth.retryAt).toBeGreaterThan(1000);

    const retried = place(scheduler, "m3", { now: fourth.retryAt });
    expect(topOf(retried)).toBe(laneTopPercent(0, "low"));
  });

  test("軌道冷卻結束後可重複使用最上方空軌", () => {
    const scheduler = new DanmakuScheduler();
    expect(topOf(place(scheduler, "m1", { density: "medium" }))).toBe(
      laneTopPercent(0, "medium"),
    );
    expect(
      topOf(place(scheduler, "m2", { density: "medium", now: 5000 })),
    ).toBe(laneTopPercent(0, "medium"));
  });

  test("切換密度後，新彈幕避開舊密度下還在入口的彈幕高度", () => {
    const scheduler = new DanmakuScheduler();
    // 「多」的第 0 條軌道覆蓋「少」第 0、1 條軌道的部分高度
    place(scheduler, "h0", { density: "high" });
    expect(topOf(place(scheduler, "low", { density: "low" }))).toBe(
      laneTopPercent(2, "low"),
    );
  });

  test("舊密度的軌道全都有彈幕時，新密度也不硬塞", () => {
    const scheduler = new DanmakuScheduler();
    const high = presetForDensity("high");
    for (let i = 0; i < high.lanes; i++) {
      place(scheduler, `h${i}`, { density: "high" });
    }
    expect(place(scheduler, "low", { density: "low" }).kind).toBe("wait");
  });

  test("發射位置記在彈幕本身，之後切換密度不會移動已發射的彈幕", () => {
    const scheduler = new DanmakuScheduler();
    const result = place(scheduler, "h0", { density: "high" });
    expect(result.kind === "placed" && result.item.topPercent).toBe(
      laneBand(0, "high").top,
    );
  });

  test("達到密度上限時略過他人訊息，但保留自己發送的彈幕", () => {
    const scheduler = new DanmakuScheduler();
    const low = presetForDensity("low");
    expect(place(scheduler, "other", { activeCount: low.maxActive }).kind).toBe(
      "drop",
    );
    const mine = place(scheduler, "mine", {
      activeCount: low.maxActive,
      isSelf: true,
    });
    expect(mine.kind).toBe("placed");
    if (mine.kind === "placed") expect(mine.item.isSelf).toBe(true);
  });

  test("密度越高，可用軌道數與高度範圍越大", () => {
    const low = presetForDensity("low");
    const medium = presetForDensity("medium");
    const high = presetForDensity("high");
    expect(low.lanes).toBeLessThan(medium.lanes);
    expect(medium.lanes).toBeLessThan(high.lanes);
    expect(laneTopPercent(low.lanes - 1, "low")).toBeLessThan(
      laneTopPercent(high.lanes - 1, "high"),
    );
  });

  test("長彈幕排隊後再發射，同軌道全程不重疊（959px 舞台、少、三則 200 字）", () => {
    // 重現 GPT 複驗：三則 200 個中文字（每字 16px）佔滿「少」的 3 條軌道，約 2 秒後再來第四則。
    const stageWidth = 959;
    const long = "長".repeat(200);
    const longWidth = 200 * 16;
    const scheduler = new DanmakuScheduler();
    type Run = {
      lane: number;
      startAt: number;
      durationMs: number;
      width: number;
    };
    const runs: Run[] = [];
    const record = (
      result: DanmakuScheduleResult,
      width: number,
      now: number,
    ) => {
      if (result.kind !== "placed") return;
      runs.push({
        lane: Math.round(result.item.topPercent * 1000),
        startAt: now,
        durationMs: result.item.durationMs,
        width,
      });
    };
    for (const id of ["a", "b", "c"]) {
      record(
        place(scheduler, id, {
          text: long,
          textWidth: longWidth,
          stageWidth,
          now: 0,
        }),
        longWidth,
        0,
      );
    }
    let now = 2_000;
    let fourth = place(scheduler, "d", {
      text: long,
      textWidth: longWidth,
      stageWidth,
      now,
    });
    while (fourth.kind === "wait") {
      now = fourth.retryAt;
      fourth = place(scheduler, "d", {
        text: long,
        textWidth: longWidth,
        stageWidth,
        now,
      });
    }
    record(fourth, longWidth, now);
    // 短的第五則接在後面（速度不同），也不能撞上前一則
    let fifth = place(scheduler, "e", {
      text: "短",
      textWidth: 16,
      stageWidth,
      now,
    });
    while (fifth.kind === "wait") {
      now = fifth.retryAt;
      fifth = place(scheduler, "e", {
        text: "短",
        textWidth: 16,
        stageWidth,
        now,
      });
    }
    record(fifth, 16, now);
    expect(runs).toHaveLength(5);

    // 以實際滑行公式逐 10ms 取樣：左邊界 x = 舞台寬 − 速度 × 經過時間
    const left = (run: Run, t: number) =>
      stageWidth -
      ((stageWidth + run.width) / run.durationMs) * (t - run.startAt);
    for (const a of runs) {
      for (const b of runs) {
        if (a === b || a.lane !== b.lane || b.startAt < a.startAt) continue;
        if (a.startAt === b.startAt) throw new Error("同軌道同時發射");
        const end = Math.min(
          a.startAt + a.durationMs,
          b.startAt + b.durationMs,
        );
        for (let t = b.startAt; t <= end; t += 10) {
          const aTail = left(a, t) + a.width;
          if (aTail <= 0) break;
          expect(left(b, t)).toBeGreaterThanOrEqual(aTail + DANMAKU_GAP_PX - 1);
        }
      }
    }
  });

  test("後一則較快時要晚一點發，免得在左側追上前一則", () => {
    const stageWidth = 960;
    const slowText = "短";
    const prev = {
      startAt: 0,
      durationMs: estimateDanmakuDurationMs(slowText),
      width: 16,
      stageWidth,
    };
    const fastText = "長".repeat(60);
    const next = {
      durationMs: estimateDanmakuDurationMs(fastText),
      width: 60 * 16,
      stageWidth,
    };
    const prevSpeed = (stageWidth + prev.width) / prev.durationMs;
    const tailClears = (prev.width + DANMAKU_GAP_PX) / prevSpeed;
    expect(earliestFollowStart(prev, next)).toBeGreaterThan(tailClears);
  });
});
