import { TITLE_MAX_LENGTH } from "@project/shared";
import { describe, expect, test } from "vitest";
import { streamTitle } from "./live-intent";

describe("streamTitle", () => {
  test("不切斷 emoji 等兩個 UTF-16 單位的字元", () => {
    const title = streamTitle("a".repeat(TITLE_MAX_LENGTH - 1) + "🎬🎬");
    expect(title).toBe("a".repeat(TITLE_MAX_LENGTH - 1));
  });

  test("片名超過上限時截斷", () => {
    expect(streamTitle("b".repeat(TITLE_MAX_LENGTH + 10))).toBe(
      "b".repeat(TITLE_MAX_LENGTH),
    );
  });

  test("空白片名送 null", () => {
    expect(streamTitle("  ")).toBeNull();
  });
});
