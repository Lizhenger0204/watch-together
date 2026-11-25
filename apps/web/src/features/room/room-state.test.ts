import { afterEach, describe, expect, test, vi } from "vitest";
import { resetMemoryStorage, roomToken } from "../../lib/storage";
import {
  forgetRoomIdentity,
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
    quality: { height: 1080, bitrate: 8_000_000, fps: 30 } as const,
    createdAt: 0,
    inviteCode: "AAAAAAAA",
    inviteCodeVersion: 0,
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

  test("重產邀請碼的 REST 回應：版本較高時依序更新", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 1,
    });
    expect(view.room).toMatchObject({
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 1,
    });
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "CCCCCCCC",
      inviteCodeVersion: 2,
    });
    expect(view.room).toMatchObject({
      inviteCode: "CCCCCCCC",
      inviteCodeVersion: 2,
    });
  });

  test.each([
    [
      "room:updated",
      {
        type: "room:updated" as const,
        room: {
          ...snapshot.room,
          inviteCode: "CCCCCCCC",
          inviteCodeVersion: 2,
        },
      },
    ],
    [
      "room:snapshot",
      {
        ...snapshot,
        room: {
          ...snapshot.room,
          inviteCode: "CCCCCCCC",
          inviteCodeVersion: 2,
        },
      },
    ],
  ])("重產的舊版 REST 回應晚於 %s：忽略，保留版本較高的碼", (_name, newer) => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, { kind: "message", message: newer });
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 1,
    });
    expect(view.room).toMatchObject({
      inviteCode: "CCCCCCCC",
      inviteCodeVersion: 2,
    });
  });

  test("雙分頁交錯換碼並斷線：先收到另一分頁的 v1 推送後，仍採用本分頁最後提交的 v2 REST 回應", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    // 另一分頁先提交並透過 WS 推送 v1，之後本分頁 WS 斷線。
    view = roomReducer(view, {
      kind: "message",
      message: {
        type: "room:updated",
        room: {
          ...snapshot.room,
          inviteCode: "BBBBBBBB",
          inviteCodeVersion: 1,
        },
      },
    });
    view = roomReducer(view, {
      kind: "connection",
      state: { status: "reconnecting", attempt: 1 },
    });
    // 本分頁最後提交的 REST 回應帶 v2 抵達：必須採用 v2，不可留在已失效的 v1。
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "CCCCCCCC",
      inviteCodeVersion: 2,
    });
    expect(view.room).toMatchObject({
      inviteCode: "CCCCCCCC",
      inviteCodeVersion: 2,
    });
  });

  test("重產期間收到仍帶舊碼的鎖房廣播後斷線：仍採用 REST 的新碼", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, {
      kind: "message",
      message: {
        type: "room:updated",
        room: { ...snapshot.room, locked: true },
      },
    });
    view = roomReducer(view, {
      kind: "connection",
      state: { status: "reconnecting", attempt: 1 },
    });
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 1,
    });
    expect(view.room).toMatchObject({
      locked: true,
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 1,
    });
  });

  test("REST 新碼生效後，晚到的舊版廣播或 snapshot 不會把畫面蓋回舊碼", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 2,
    });
    view = roomReducer(view, {
      kind: "message",
      message: {
        type: "room:updated",
        room: {
          ...snapshot.room,
          quality: { height: 720, bitrate: "source", fps: 60 },
          inviteCodeVersion: 1,
        },
      },
    });
    expect(view.room).toMatchObject({
      quality: { height: 720, bitrate: "source", fps: 60 },
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 2,
    });
    view = roomReducer(view, {
      kind: "message",
      message: {
        ...snapshot,
        room: { ...snapshot.room, locked: true, inviteCodeVersion: 1 },
      },
    });
    expect(view.room).toMatchObject({
      locked: true,
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 2,
    });
  });

  test("亂序抵達的舊版 REST 回應會被忽略", () => {
    let view = roomReducer(initialRoomView, {
      kind: "message",
      message: snapshot,
    });
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "CCCCCCCC",
      inviteCodeVersion: 2,
    });
    view = roomReducer(view, {
      kind: "invite-code",
      inviteCode: "BBBBBBBB",
      inviteCodeVersion: 1,
    });
    expect(view.room).toMatchObject({
      inviteCode: "CCCCCCCC",
      inviteCodeVersion: 2,
    });
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

describe("forgetRoomIdentity", () => {
  const ROOM = crypto.randomUUID();
  const key = `room:${ROOM}:token`;
  const shared = new Map<string, string>();
  afterEach(() => {
    vi.unstubAllGlobals();
    resetMemoryStorage();
    shared.clear();
  });
  const stubStorage = () =>
    vi.stubGlobal("localStorage", {
      get length() {
        return shared.size;
      },
      key: (i: number) => [...shared.keys()][i] ?? null,
      getItem: (k: string) => shared.get(k) ?? null,
      setItem: (k: string, v: string) => void shared.set(k, v),
      removeItem: (k: string) => void shared.delete(k),
    });

  test("舊分頁收到 4401：只清自己的憑證，保留另一分頁剛寫入的新憑證", () => {
    stubStorage();
    const old = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    roomToken.set(ROOM, old);
    shared.set(key, fresh); // 另一分頁重新加入
    forgetRoomIdentity(ROOM, old);
    expect(shared.get(key)).toBe(fresh);
    expect(roomToken.get(ROOM)).toBe(fresh);
  });

  test("共用儲存仍是自己的憑證：清掉", () => {
    stubStorage();
    const token = crypto.randomUUID();
    roomToken.set(ROOM, token);
    forgetRoomIdentity(ROOM, token);
    expect(shared.has(key)).toBe(false);
    expect(roomToken.get(ROOM)).toBeNull();
  });

  test("本機 token 格式損壞（null）：整份清掉", () => {
    stubStorage();
    shared.set(key, "broken");
    forgetRoomIdentity(ROOM, null);
    expect(shared.has(key)).toBe(false);
  });
});

describe("uploadHint（P2P 總頻寬保護，streaming.md §2）", () => {
  test("3 人 8 Mbps：24 Mbps，不提醒", () => {
    expect(uploadHint("p2p", 8_000_000, 3)).toEqual({
      total: 24_000_000,
      warn: false,
    });
  });
  test("剛好 60 Mbps 不提醒，超過才提醒", () => {
    // 15 Mbps × 4 人 = 60 Mbps；10 Mbps × 7 人 = 70 Mbps。
    expect(uploadHint("p2p", 15_000_000, 4)).toEqual({
      total: 60_000_000,
      warn: false,
    });
    expect(uploadHint("p2p", 10_000_000, 7)?.warn).toBe(true);
    // 8 Mbps：7 人 56 Mbps 不提醒，8 人 64 Mbps 提醒。
    expect(uploadHint("p2p", 8_000_000, 7)?.warn).toBe(false);
    expect(uploadHint("p2p", 8_000_000, 8)?.warn).toBe(true);
  });
  test("轉發模式或沒有收看者：不提示", () => {
    expect(uploadHint("relay", 15_000_000, 20)).toBeNull();
    expect(uploadHint("p2p", 15_000_000, 0)).toBeNull();
  });
  test("formatMbps", () => {
    expect(formatMbps(18_000_000)).toBe("18 Mbps");
    expect(formatMbps(4_500_000)).toBe("4.5 Mbps");
  });
});
