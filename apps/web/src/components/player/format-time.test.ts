import { describe, expect, it } from "vitest";
import { formatTime } from "./format-time";

describe("formatTime", () => {
  it("一小時內顯示 m:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(1.9)).toBe("0:01");
    expect(formatTime(23 * 60 + 40)).toBe("23:40");
  });

  it("一小時以上顯示 h:mm:ss", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(2 * 3600 + 5 * 60 + 7)).toBe("2:05:07");
  });

  it("負數、NaN、無限大都顯示 0:00", () => {
    expect(formatTime(-3)).toBe("0:00");
    expect(formatTime(Number.NaN)).toBe("0:00");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
