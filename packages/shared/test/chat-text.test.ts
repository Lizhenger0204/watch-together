import { describe, expect, test } from "vitest";
import {
  CHAT_MAX_LENGTH,
  CHAT_RAW_MAX_LENGTH,
  chatTextLength,
  clampChatRawText,
  normalizeChatText,
  parseClientMessage,
} from "../src";

const send = (text: string) =>
  parseClientMessage(JSON.stringify({ type: "chat:send", text })).ok;

describe("聊天文字計數與正規化", () => {
  test("以 code point 計數：emoji 算 1 字，與 JavaScript 的 .length 不同", () => {
    expect(chatTextLength("🙂")).toBe(1);
    expect("🙂".length).toBe(2);
    expect(chatTextLength("中文ab🙂")).toBe(5);
  });

  test("正規化把換行改成空白並去掉前後空白", () => {
    expect(normalizeChatText("  a\r\n\nb  ")).toBe("a b");
  });

  test("schema 與計數函式一致：200 個 emoji 可送，201 個拒絕", () => {
    expect(send("🙂".repeat(CHAT_MAX_LENGTH))).toBe(true);
    expect(send("🙂".repeat(CHAT_MAX_LENGTH + 1))).toBe(false);
  });

  test("長度以正規化後計算：前後空白不佔字數", () => {
    expect(send(`   ${"字".repeat(CHAT_MAX_LENGTH)}   `)).toBe(true);
  });

  test("原始字串上限以 code point 截斷：900 空白＋50 個 😀＋尾 不會被截掉", () => {
    const raw = " ".repeat(900) + "😀".repeat(50) + "尾";
    expect(raw.length).toBeGreaterThan(CHAT_RAW_MAX_LENGTH);
    expect(clampChatRawText(raw)).toBe(raw);
    expect(send(raw)).toBe(true);
  });

  test("超過原始上限時只保留前 CHAT_RAW_MAX_LENGTH 個 code point，不切斷 emoji", () => {
    const raw = "😀".repeat(CHAT_RAW_MAX_LENGTH + 5);
    const clamped = clampChatRawText(raw);
    expect(chatTextLength(clamped)).toBe(CHAT_RAW_MAX_LENGTH);
    expect(clamped).toBe("😀".repeat(CHAT_RAW_MAX_LENGTH));
  });
});
