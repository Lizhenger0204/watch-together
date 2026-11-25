import type { ChatMessage } from "@project/shared";
import { describe, expect, test } from "vitest";
import { countUnreadMessages } from "./SidebarTabs";

const msg = (id: string): ChatMessage => ({
  id,
  memberId: "u1",
  nickname: "小美",
  role: "member",
  text: id,
  sentAt: 1000,
});

describe("countUnreadMessages", () => {
  test("還沒看過聊天室時，全部新訊息都算未讀", () => {
    expect(countUnreadMessages([], null)).toBe(0);
    expect(countUnreadMessages([msg("a"), msg("b")], null)).toBe(2);
  });

  test("只計算最後已讀訊息之後的新訊息", () => {
    expect(countUnreadMessages([msg("a"), msg("b"), msg("c")], "a")).toBe(2);
    expect(countUnreadMessages([msg("a"), msg("b"), msg("c")], "c")).toBe(0);
  });

  test("上次已讀的訊息已被上限擠掉時，回傳目前全部筆數", () => {
    expect(countUnreadMessages([msg("b"), msg("c")], "a")).toBe(2);
  });
});
