import { expect, test } from "vitest";
import { parseRoute } from "./router";

test.each([
  ["/", { page: "home" }],
  ["/join/ABCD-EFGH", { page: "join", inviteCode: "ABCD-EFGH" }],
  [
    "/rooms/0b6f6e2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    { page: "room", roomId: "0b6f6e2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b" },
  ],
  ["/rooms/not-a-uuid", { page: "not-found" }],
  ["/whatever", { page: "not-found" }],
])("%s", (path, route) => {
  expect(parseRoute(path)).toEqual(route);
});
