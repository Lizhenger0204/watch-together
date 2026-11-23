import { describe, expect, test } from "vitest";
import {
  estimateP2pUpload,
  formatMbps,
  initialRoomView,
  roomReducer,
} from "./room-state";

const member = (id: string, online = true) => ({
  memberId: id,
  nickname: id,
  role: "member" as const,
  online,
});

describe("roomReducer", () => {
  test("成員離開房間時，一併移除他的連線狀態", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: {
        type: "member:status",
        memberId: "a",
        status: { state: "playing" },
      },
    });
    view = roomReducer(view, {
      kind: "message",
      message: {
        type: "member:status",
        memberId: "b",
        status: { state: "buffering" },
      },
    });
    view = roomReducer(view, {
      kind: "message",
      message: { type: "room:members", members: [member("a")] },
    });
    expect(Object.keys(view.memberStatus)).toEqual(["a"]);
  });

  test("stream:status 更新直播狀態", () => {
    const view = roomReducer(initialRoomView, {
      kind: "message",
      message: {
        type: "stream:status",
        live: true,
        title: "電影",
        startedAt: 5,
      },
    });
    expect(view.stream).toEqual({ live: true, title: "電影", startedAt: 5 });
  });

  test("room:closed 記錄原因", () => {
    const view = roomReducer(initialRoomView, {
      kind: "message",
      message: { type: "room:closed", reason: "kicked" },
    });
    expect(view.closedBy).toBe("kicked");
  });
});

describe("estimateP2pUpload", () => {
  test("3 人標準畫質：18 Mbps，不提醒", () => {
    expect(estimateP2pUpload("standard", 3)).toEqual({
      total: 18_000_000,
      warn: false,
    });
  });
  test("7 人高畫質：56 Mbps，不提醒；8 人超過 60 Mbps 才提醒", () => {
    expect(estimateP2pUpload("high", 7).warn).toBe(false);
    expect(estimateP2pUpload("high", 8).warn).toBe(true);
  });
  test("formatMbps", () => {
    expect(formatMbps(18_000_000)).toBe("18 Mbps");
    expect(formatMbps(4_500_000)).toBe("4.5 Mbps");
  });
});
