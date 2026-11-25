import { describe, expect, test } from "vitest";
import {
  DanmakuScheduler,
  laneTopPercent,
  presetForDensity,
} from "./danmaku-lanes";

describe("DanmakuScheduler", () => {
  test("同時抵達的彈幕優先分配到不同軌道，避免重疊", () => {
    const scheduler = new DanmakuScheduler();
    const lanes = [0, 1, 2].map(
      (i) =>
        scheduler.schedule({
          id: `m${i}`,
          text: "你好",
          density: "low",
          activeCount: i,
          now: 1000,
          isSelf: false,
        })?.lane,
    );
    expect(lanes).toEqual([0, 1, 2]);
  });

  test("軌道冷卻結束後可重複使用最上方空軌", () => {
    const scheduler = new DanmakuScheduler();
    const first = scheduler.schedule({
      id: "m1",
      text: "短句",
      density: "medium",
      activeCount: 0,
      now: 1000,
      isSelf: false,
    });
    expect(first?.lane).toBe(0);

    const later = scheduler.schedule({
      id: "m2",
      text: "另一句",
      density: "medium",
      activeCount: 1,
      now: 5000,
      isSelf: false,
    });
    expect(later?.lane).toBe(0);
  });

  test("達到密度上限時節流他人訊息，但保留自己發送的彈幕", () => {
    const scheduler = new DanmakuScheduler();
    const low = presetForDensity("low");

    const dropped = scheduler.schedule({
      id: "other",
      text: "人好多",
      density: "low",
      activeCount: low.maxActive,
      now: 1000,
      isSelf: false,
    });
    expect(dropped).toBeNull();

    const mine = scheduler.schedule({
      id: "mine",
      text: "我自己發的",
      density: "low",
      activeCount: low.maxActive,
      now: 1000,
      isSelf: true,
    });
    expect(mine).not.toBeNull();
    expect(mine?.isSelf).toBe(true);
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
