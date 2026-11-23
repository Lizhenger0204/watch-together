import { expect, test } from "vitest";
import { parseRoute, readNotice } from "./router";

test.each([
  ["/", { page: "home" }],
  ["/join/ABCD-EFGH", { page: "join", inviteCode: "ABCD-EFGH" }],
  [
    "/rooms/0b6f6e2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    { page: "room", roomId: "0b6f6e2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b" },
  ],
  ["/rooms/not-a-uuid", { page: "not-found" }],
  ["/whatever", { page: "not-found" }],
  ["/join/abcd%20efgh", { page: "join", inviteCode: "abcd efgh" }],
  // 截斷的百分比編碼不可丟 URIError，交給加入表單提示格式錯誤。
  ["/join/ABCD%E", { page: "join", inviteCode: "ABCD%E" }],
])("%s", (path, route) => {
  expect(parseRoute(path)).toEqual(route);
});

test("readNotice 只接受字串提示", () => {
  expect(readNotice({ notice: "房間已關閉" })).toBe("房間已關閉");
  expect(readNotice(null)).toBeNull();
  expect(readNotice({ notice: 1 })).toBeNull();
});
