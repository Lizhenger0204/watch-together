import type { ChatMessage } from "@project/shared";
import { describe, expect, test } from "vitest";
import {
  countUnreadMessages,
  nextTabIndex,
  sidebarTabIds,
} from "./SidebarTabs";

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

describe("nextTabIndex", () => {
  test("左右鍵循環切換，Home／End 到頭尾", () => {
    expect(nextTabIndex("ArrowRight", 0, 2)).toBe(1);
    expect(nextTabIndex("ArrowRight", 1, 2)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 2)).toBe(1);
    expect(nextTabIndex("Home", 1, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
  });

  test("其他按鍵不處理，交給瀏覽器預設行為", () => {
    expect(nextTabIndex("Enter", 0, 2)).toBeNull();
    expect(nextTabIndex("Tab", 0, 2)).toBeNull();
  });
});

describe("sidebarTabIds", () => {
  test("分頁與面板的 id 成對，供 aria-controls／aria-labelledby 互相引用", () => {
    expect(sidebarTabIds("viewer-side", "chat")).toEqual({
      tabId: "viewer-side-tab-chat",
      panelId: "viewer-side-panel-chat",
    });
  });
});
