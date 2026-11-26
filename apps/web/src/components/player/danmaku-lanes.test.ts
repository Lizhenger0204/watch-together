import { describe, expect, test } from "vitest";
import {
  DanmakuScheduler,
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
  } = {},
): DanmakuScheduleResult {
  return scheduler.schedule({
    id,
    text: opts.text ?? "你好",
    density: opts.density ?? "low",
    activeCount: opts.activeCount ?? 0,
    now: opts.now ?? 1000,
    isSelf: opts.isSelf ?? false,
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
});
