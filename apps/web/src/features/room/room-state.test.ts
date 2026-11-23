import { describe, expect, test } from "vitest";
import {
  estimateP2pUpload,
  formatMbps,
  initialRoomView,
  roomExit,
  roomReducer,
  type RoomView,
} from "./room-state";

const snapshot = {
  type: "room:snapshot" as const,
  room: {
    roomId: "r",
    locked: false,
    mode: "p2p" as const,
    quality: "standard" as const,
    createdAt: 0,
    inviteCode: "AAAAAAAA",
  },
  members: [],
  stream: { live: false, title: null, startedAt: null },
  you: { memberId: "h", role: "host" as const },
};

const playing = (memberId: string) => ({
  kind: "message" as const,
  message: {
    type: "member:status" as const,
    memberId,
    status: { state: "playing" as const, bitrateKbps: 6000 },
  },
});

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

describe("roomReducer：連線品質與重新驗證", () => {
  test("成員離線時清掉他的即時統計（不再顯示觀看中與舊碼率）", () => {
    let view = roomReducer(initialRoomView, playing("a"));
    view = roomReducer(view, {
      kind: "message",
      message: { type: "room:members", members: [member("a", false)] },
    });
    expect(view.memberStatus).toEqual({});
  });

  test("每次 snapshot：session 加一，前一條連線的統計作廢", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    expect(view.session).toBe(1);
    view = roomReducer(view, playing("a"));
    view = roomReducer(view, { kind: "message", message: snapshot });
    expect(view.session).toBe(2);
    expect(view.memberStatus).toEqual({});
  });

  test("重產邀請碼的 REST 回應直接更新邀請碼；之後的廣播仍以最後收到的為準", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, { kind: "invite-code", inviteCode: "BBBBBBBB" });
    expect(view.room?.inviteCode).toBe("BBBBBBBB");
    view = roomReducer(view, { kind: "invite-code", inviteCode: "CCCCCCCC" });
    expect(view.room?.inviteCode).toBe("CCCCCCCC");
  });
});

describe("roomExit", () => {
  const closed = (reason: string): RoomView => ({
    ...initialRoomView,
    connection: { status: "closed", reason } as RoomView["connection"],
  });

  test.each(["room_closed", "kicked", "unauthorized"])(
    "%s：離開房間並帶提示",
    (reason) => {
      expect(roomExit(closed(reason))?.notice).toBeTruthy();
    },
  );

  test.each(["replaced", "bad_request", "stopped"])(
    "%s：留在房間頁",
    (reason) => {
      expect(roomExit(closed(reason))).toBeNull();
    },
  );

  test("收到 room:closed 就離開（不必等關閉碼）", () => {
    expect(
      roomExit({ ...initialRoomView, closedBy: "expired" })?.notice,
    ).toContain("房間已關閉");
    expect(
      roomExit({ ...initialRoomView, closedBy: "kicked" })?.notice,
    ).toContain("請出房間");
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
