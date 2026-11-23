import { describe, expect, test } from "vitest";
import {
  INVITE_CODE_ALPHABET,
  formatInviteCode,
  normalizeInviteCode,
} from "../src";

describe("normalizeInviteCode", () => {
  test.each([
    ["ABCD-EFGH", "ABCDEFGH"],
    ["abcd-efgh", "ABCDEFGH"],
    [" abcd efgh ", "ABCDEFGH"],
    ["AB-CD-EF-GH", "ABCDEFGH"],
    ["23456789", "23456789"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeInviteCode(input)).toBe(expected);
  });

  test.each([
    ["ABCDEFG", "太短"],
    ["ABCDEFGHJ", "太長"],
    ["ABCDEFG0", "含 0"],
    ["ABCDEFGO", "含 O"],
    ["ABCDEFG1", "含 1"],
    ["ABCDEFGI", "含 I"],
    ["ABCDEFGL", "含 L"],
    ["ABCD_EFG", "含底線"],
    ["", "空字串"],
  ])("%j 不合法（%s）", (input) => {
    expect(normalizeInviteCode(input)).toBeNull();
  });

  test("字元集不含易混淆字元", () => {
    for (const ch of "01OIL") expect(INVITE_CODE_ALPHABET).not.toContain(ch);
  });
});

test("formatInviteCode 顯示成 ABCD-EFGH", () => {
  expect(formatInviteCode("ABCDEFGH")).toBe("ABCD-EFGH");
});
