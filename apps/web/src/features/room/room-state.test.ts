import { describe, expect, test } from "vitest";
import {
  formatMbps,
  initialRoomView,
  roomExit,
  roomReducer,
  type RoomView,
  uploadHint,
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

  test("重產邀請碼的 REST 回應：期間沒有新的房間狀態就直接更新", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, { kind: "invite-requested", id: 1 });
    view = roomReducer(view, {
      kind: "invite-code",
      id: 1,
      inviteCode: "BBBBBBBB",
    });
    expect(view.room?.inviteCode).toBe("BBBBBBBB");
    view = roomReducer(view, { kind: "invite-requested", id: 2 });
    view = roomReducer(view, {
      kind: "invite-code",
      id: 2,
      inviteCode: "CCCCCCCC",
    });
    expect(view.room?.inviteCode).toBe("CCCCCCCC");
  });

  test.each([
    [
      "room:updated",
      {
        type: "room:updated" as const,
        room: { ...snapshot.room, inviteCode: "CCCCCCCC" },
      },
    ],
    [
      "room:snapshot",
      { ...snapshot, room: { ...snapshot.room, inviteCode: "CCCCCCCC" } },
    ],
  ])("重產的 REST 回應晚於 %s：忽略，保留較新的碼", (_name, newer) => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, { kind: "invite-requested", id: 7 });
    view = roomReducer(view, { kind: "message", message: newer });
    view = roomReducer(view, {
      kind: "invite-code",
      id: 7,
      inviteCode: "BBBBBBBB",
    });
    expect(view.room?.inviteCode).toBe("CCCCCCCC");
  });

  test("不是最後一次送出的重產回應也忽略", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, { kind: "invite-requested", id: 1 });
    view = roomReducer(view, { kind: "invite-requested", id: 2 });
    view = roomReducer(view, {
      kind: "invite-code",
      id: 1,
      inviteCode: "BBBBBBBB",
    });
    expect(view.room?.inviteCode).toBe("AAAAAAAA");
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
    ).toContain("房間已到期");
    expect(
      roomExit({ ...initialRoomView, closedBy: "kicked" })?.notice,
    ).toContain("請出房間");
  });

  test("依 closedBy 區分房主關閉與到期", () => {
    const hostClosed = roomExit({
      ...initialRoomView,
      closedBy: "host_closed",
    })?.notice;
    expect(hostClosed).toContain("房主已關閉房間");
    expect(hostClosed).not.toContain("24 小時");
    const expired = roomExit({
      ...initialRoomView,
      closedBy: "expired",
    })?.notice;
    expect(expired).toContain("24 小時");
    expect(expired).not.toContain("房主已關閉");
    // 沒收到 room:closed、只有 4001：不知道原因，兩種都提到。
    const unknown = roomExit(closed("room_closed"))?.notice;
    expect(unknown).toContain("房主關閉");
    expect(unknown).toContain("24 小時");
  });
});

describe("uploadHint（P2P 總頻寬保護，streaming.md §2）", () => {
  test("3 人標準畫質：18 Mbps，不提醒", () => {
    expect(uploadHint("p2p", "standard", 3)).toEqual({
      total: 18_000_000,
      warn: false,
    });
  });
  test("剛好 60 Mbps 不提醒，超過才提醒", () => {
    // 標準 6 Mbps × 10 人 = 60 Mbps；× 11 人 = 66 Mbps。
    expect(uploadHint("p2p", "standard", 10)).toEqual({
      total: 60_000_000,
      warn: false,
    });
    expect(uploadHint("p2p", "standard", 11)?.warn).toBe(true);
    // 高畫質 8 Mbps：7 人 56 Mbps 不提醒，8 人 64 Mbps 提醒。
    expect(uploadHint("p2p", "high", 7)?.warn).toBe(false);
    expect(uploadHint("p2p", "high", 8)?.warn).toBe(true);
  });
  test("轉發模式或沒有收看者：不提示", () => {
    expect(uploadHint("relay", "high", 20)).toBeNull();
    expect(uploadHint("p2p", "high", 0)).toBeNull();
  });
  test("formatMbps", () => {
    expect(formatMbps(18_000_000)).toBe("18 Mbps");
    expect(formatMbps(4_500_000)).toBe("4.5 Mbps");
  });
});
