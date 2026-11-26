import { describe, expect, test } from "vitest";
import { restoreUnsentDraft } from "./chat-draft";

describe("restoreUnsentDraft", () => {
  test("等待期間沒有新打字：放回原本送出的文字", () => {
    expect(restoreUnsentDraft("第一則", "")).toBe("第一則");
  });

  test("等待期間接著打字：送出的文字放回前面，新打的字接在後面", () => {
    expect(restoreUnsentDraft("第一則", "第二則")).toBe("第一則第二則");
  });

  test("合併後超過原始上限也不截斷，等待期間新打的字不會消失", () => {
    const sent = " ".repeat(999) + "甲";
    expect(restoreUnsentDraft(sent, "第二則")).toBe(`${sent}第二則`);
  });
});
