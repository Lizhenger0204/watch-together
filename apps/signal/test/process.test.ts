import { describe, expect, test } from "vitest";
import { createRoomState, type RoomState } from "../src/room/room";
import { ChatRateLimiter } from "../src/signaling/chat-rate-limit";
import {
  CLOSE,
  onAuth,
  onDisconnect,
  onHostOfflineTimeout,
  onLeave,
  onMessage,
  type Effect,
} from "../src/signaling/process";

const T0 = 1_000_000;

function roomWith(overrides: Partial<RoomState> = {}): RoomState {
  const base = createRoomState({
    roomId: "r1",
    inviteCode: "ABCDEFGH",
    host: { memberId: "host", nickname: "房主", tokenHash: "h-host" },
    now: T0,
  });
  return {
    ...base,
    members: [
      ...base.members,
      {
        memberId: "a",
        nickname: "A",
        role: "member",
        tokenHash: "h-a",
        joinedAt: T0,
        lastSeenAt: T0,
      },
      {
        memberId: "b",
        nickname: "B",
        role: "member",
        tokenHash: "h-b",
        joinedAt: T0,
        lastSeenAt: T0,
      },
    ],
    ...overrides,
  };
}
const LIVE = { live: true, title: "電影", startedAt: T0 };

/** 取出送給某成員的訊息 type。 */
const sentTo = (effects: Effect[], memberId: string) =>
  effects
    .filter(
      (e) =>
        e.kind === "send" && "memberId" in e.to && e.to.memberId === memberId,
    )
    .map((e) => (e.kind === "send" ? e.message : null));
const typesTo = (effects: Effect[], memberId: string) =>
  sentTo(effects, memberId).map((m) => m?.type);

describe("onAuth", () => {
  test("協定版本不符：回錯誤並關閉連線", () => {
    const outcome = onAuth(
      roomWith(),
      { tokenHash: "h-a", protocolVersion: 99 },
      1,
      new Set(),
      T0,
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.effects).toContainEqual(
      expect.objectContaining({ kind: "close", code: CLOSE.BAD_REQUEST }),
    );
  });

  test("token 不對：UNAUTHORIZED 並關閉", () => {
    const outcome = onAuth(
      roomWith(),
      { tokenHash: "nope", protocolVersion: 1 },
      1,
      new Set(),
      T0,
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.effects).toContainEqual(
      expect.objectContaining({ kind: "close", code: CLOSE.UNAUTHORIZED }),
    );
  });

  test("成功：送 snapshot 給自己、成員列表給其他人，清除閒置計時", () => {
    const outcome = onAuth(
      roomWith(),
      { tokenHash: "h-a", protocolVersion: 1, reqId: "1" },
      1,
      new Set(["host"]),
      T0 + 5,
    );
    if (!outcome.accepted) throw new Error("應該接受");
    expect(outcome.memberId).toBe("a");
    expect(outcome.state.idleSince).toBeNull();
    expect(typesTo(outcome.effects, "a")).toEqual(["room:snapshot", "ack"]);
    expect(typesTo(outcome.effects, "host")).toEqual(["room:members"]);
    const snapshot = sentTo(outcome.effects, "a")[0];
    expect(snapshot).toMatchObject({ you: { memberId: "a", role: "member" } });
    expect(snapshot).not.toHaveProperty("room.inviteCode");
  });

  test("P2P 直播中，收看者上線會請房主發起連線", () => {
    const outcome = onAuth(
      roomWith({ stream: LIVE }),
      { tokenHash: "h-a", protocolVersion: 1 },
      1,
      new Set(["host"]),
      T0,
    );
    expect(sentTo(outcome.effects, "host")).toContainEqual({
      type: "peer:request",
      memberId: "a",
    });
  });

  test("轉發模式不送 peer:request", () => {
    const outcome = onAuth(
      roomWith({ stream: LIVE, mode: "relay" }),
      { tokenHash: "h-a", protocolVersion: 1 },
      1,
      new Set(["host"]),
      T0,
    );
    expect(typesTo(outcome.effects, "host")).not.toContain("peer:request");
  });
});

describe("房主重新驗證（重新整理、4000 取代、斷線重連）", () => {
  test("直播中：改為未開播、通知收看者，不送 peer:request", () => {
    const outcome = onAuth(
      roomWith({ stream: LIVE }),
      { tokenHash: "h-host", protocolVersion: 1 },
      1,
      new Set(["host", "a", "b"]),
      T0 + 5,
    );
    if (!outcome.accepted) throw new Error("應該通過驗證");
    expect(outcome.state.stream.live).toBe(false);
    const snapshot = sentTo(outcome.effects, "host")[0];
    expect(snapshot).toMatchObject({
      type: "room:snapshot",
      stream: { live: false },
    });
    expect(typesTo(outcome.effects, "host")).not.toContain("peer:request");
    expect(sentTo(outcome.effects, "a")).toContainEqual({
      type: "stream:status",
      live: false,
      title: null,
      startedAt: null,
    });

    // 房主端再宣告開播 → 對所有在線收看者送 peer:request
    const relive = onMessage(
      outcome.state,
      "host",
      { type: "stream:status", live: true, title: "電影" },
      new Set(["host", "a", "b"]),
      T0 + 6,
    );
    expect(sentTo(relive.effects, "host")).toEqual(
      expect.arrayContaining([
        { type: "peer:request", memberId: "a" },
        { type: "peer:request", memberId: "b" },
      ]),
    );
  });

  test("直播中：先對收看者送停播，再回房主 snapshot（protocol.md 的順序）", () => {
    const outcome = onAuth(
      roomWith({ stream: LIVE }),
      { tokenHash: "h-host", protocolVersion: 1 },
      1,
      new Set(["host", "a"]),
      T0 + 5,
    );
    if (!outcome.accepted) throw new Error("應該通過驗證");
    const order = outcome.effects.flatMap((e) =>
      e.kind === "send" && "memberId" in e.to
        ? [`${e.to.memberId} ${e.message.type}`]
        : [],
    );
    const stop = order.indexOf("a stream:status");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(order.indexOf("host room:snapshot"));
  });

  test("未開播：不送 stream:status", () => {
    const outcome = onAuth(
      roomWith(),
      { tokenHash: "h-host", protocolVersion: 1 },
      1,
      new Set(["a"]),
      T0 + 5,
    );
    expect(typesTo(outcome.effects, "a")).toEqual(["room:members"]);
  });
});

describe("onMessage 權限", () => {
  const online = new Set(["host", "a", "b"]);

  test.each([
    { type: "room:update", reqId: "1", locked: true },
    { type: "room:kick", reqId: "1", memberId: "b" },
    { type: "stream:status", reqId: "1", live: true, title: null },
  ] as const)("收看者送 $type → FORBIDDEN", (message) => {
    const state = roomWith();
    const outcome = onMessage(state, "a", message, online, T0);
    expect(outcome.state).toBe(state);
    expect(sentTo(outcome.effects, "a")).toEqual([
      { type: "ack", reqId: "1", ok: false, code: "FORBIDDEN" },
    ]);
  });

  test("房主改畫質：存下新檔位並廣播給全房", () => {
    const quality = { height: 720, bitrate: "source", fps: 60 } as const;
    const outcome = onMessage(
      roomWith(),
      "host",
      { type: "room:update", reqId: "1", quality },
      online,
      T0,
    );
    expect(outcome.state.quality).toEqual(quality);
    for (const id of ["host", "a", "b"]) {
      expect(
        sentTo(outcome.effects, id).find((m) => m?.type === "room:updated"),
      ).toMatchObject({ room: { quality } });
    }
  });

  test("房主送 member:status → FORBIDDEN", () => {
    const outcome = onMessage(
      roomWith(),
      "host",
      { type: "member:status", state: "playing" },
      online,
      T0,
    );
    expect(sentTo(outcome.effects, "host")[0]).toMatchObject({
      type: "error",
      code: "FORBIDDEN",
    });
  });
});

describe("signal 轉送", () => {
  const online = new Set(["host", "a", "b"]);
  const offer = {
    type: "offer",
    negotiationId: "offer-2",
    sdp: "v=0",
  } as const;

  test("房主 → 收看者", () => {
    const outcome = onMessage(
      roomWith(),
      "host",
      { type: "signal", to: "a", data: offer },
      online,
      T0,
    );
    expect(sentTo(outcome.effects, "a")).toEqual([
      { type: "signal", from: "host", data: offer },
    ]);
  });

  test("新 offer 之後，仍將收看者遲到及當次的回覆各帶原識別轉給房主", () => {
    const { state } = onMessage(
      roomWith(),
      "host",
      { type: "signal", to: "a", data: offer },
      online,
      T0,
    );
    const replies = [
      { type: "answer", negotiationId: "offer-1", sdp: "v=0 old" },
      { type: "ice", negotiationId: "offer-1", candidate: null },
      { type: "answer", negotiationId: offer.negotiationId, sdp: "v=0 new" },
    ] as const;
    for (const data of replies) {
      const outcome = onMessage(
        state,
        "a",
        { type: "signal", to: "host", data },
        online,
        T0,
      );
      expect(sentTo(outcome.effects, "host")).toEqual([
        { type: "signal", from: "a", data },
      ]);
    }
  });

  test("收看者 → 其他收看者：被擋下", () => {
    const outcome = onMessage(
      roomWith(),
      "a",
      { type: "signal", to: "b", data: offer },
      online,
      T0,
    );
    expect(sentTo(outcome.effects, "b")).toEqual([]);
    expect(sentTo(outcome.effects, "a")[0]).toMatchObject({
      type: "error",
      code: "FORBIDDEN",
    });
  });

  test("對方離線：回錯誤", () => {
    const outcome = onMessage(
      roomWith(),
      "host",
      { type: "signal", to: "b", data: offer },
      new Set(["host", "a"]),
      T0,
    );
    expect(sentTo(outcome.effects, "host")[0]).toMatchObject({
      type: "error",
      code: "BAD_REQUEST",
    });
  });
});

describe("房主操作", () => {
  const online = new Set(["host", "a", "b"]);

  test("開播：廣播 stream:status，P2P 模式對每位收看者送 peer:request", () => {
    const outcome = onMessage(
      roomWith(),
      "host",
      { type: "stream:status", reqId: "1", live: true, title: "電影" },
      online,
      T0 + 10,
    );
    expect(outcome.state.stream).toEqual({
      live: true,
      title: "電影",
      startedAt: T0 + 10,
    });
    expect(typesTo(outcome.effects, "a")).toEqual(["stream:status"]);
    expect(sentTo(outcome.effects, "host")).toEqual(
      expect.arrayContaining([
        { type: "peer:request", memberId: "a" },
        { type: "peer:request", memberId: "b" },
      ]),
    );
  });

  test("直播中更新片名不會重送 peer:request，startedAt 不變", () => {
    const outcome = onMessage(
      roomWith({ stream: LIVE }),
      "host",
      { type: "stream:status", live: true, title: "新片" },
      online,
      T0 + 99,
    );
    expect(outcome.state.stream.startedAt).toBe(T0);
    expect(typesTo(outcome.effects, "host")).not.toContain("peer:request");
  });

  test("從轉發切回 P2P 時送 peer:request；room:updated 只有房主看得到邀請碼", () => {
    const outcome = onMessage(
      roomWith({ stream: LIVE, mode: "relay" }),
      "host",
      { type: "room:update", mode: "p2p" },
      online,
      T0,
    );
    expect(outcome.state.mode).toBe("p2p");
    expect(typesTo(outcome.effects, "host")).toContain("peer:request");
    const toHost = sentTo(outcome.effects, "host").find(
      (m) => m?.type === "room:updated",
    );
    const toA = sentTo(outcome.effects, "a").find(
      (m) => m?.type === "room:updated",
    );
    expect(toHost).toHaveProperty("room.inviteCode", "ABCDEFGH");
    expect(toA).not.toHaveProperty("room.inviteCode");
  });

  test("踢人：移除成員、通知並關閉其連線、廣播成員列表", () => {
    const outcome = onMessage(
      roomWith(),
      "host",
      { type: "room:kick", memberId: "b" },
      online,
      T0,
    );
    expect(outcome.state.members.map((m) => m.memberId)).toEqual(["host", "a"]);
    expect(sentTo(outcome.effects, "b")).toContainEqual({
      type: "room:closed",
      reason: "kicked",
    });
    expect(outcome.effects).toContainEqual(
      expect.objectContaining({
        kind: "close",
        to: { memberId: "b" },
        code: CLOSE.KICKED,
      }),
    );
    expect(typesTo(outcome.effects, "a")).toEqual(["room:members"]);
  });

  test("不能踢房主", () => {
    const outcome = onMessage(
      roomWith(),
      "host",
      { type: "room:kick", reqId: "1", memberId: "host" },
      online,
      T0,
    );
    expect(sentTo(outcome.effects, "host")).toEqual([
      { type: "ack", reqId: "1", ok: false, code: "BAD_REQUEST" },
    ]);
  });

  test("收看者回報狀態只轉給房主", () => {
    const outcome = onMessage(
      roomWith(),
      "a",
      { type: "member:status", state: "playing", rttMs: 30 },
      online,
      T0,
    );
    expect(sentTo(outcome.effects, "host")).toEqual([
      {
        type: "member:status",
        memberId: "a",
        status: { state: "playing", rttMs: 30 },
      },
    ]);
    expect(sentTo(outcome.effects, "b")).toEqual([]);
  });
});

describe("聊天室（chat:send）", () => {
  const online = new Set(["host", "a"]);

  test("房主與收看者都可發言，廣播給所有在線成員（含自己）並忽略離線者", () => {
    const state = roomWith();
    const fromHost = onMessage(
      state,
      "host",
      { type: "chat:send", reqId: "c1", text: "準備開播" },
      online,
      T0 + 10,
      { generateId: () => "msg-1" },
    );
    expect(fromHost.state).toBe(state);
    const expected = {
      type: "chat:message",
      id: "msg-1",
      memberId: "host",
      nickname: "房主",
      role: "host",
      text: "準備開播",
      sentAt: T0 + 10,
    };
    expect(sentTo(fromHost.effects, "host")).toEqual([
      { type: "ack", reqId: "c1", ok: true },
      expected,
    ]);
    expect(sentTo(fromHost.effects, "a")).toEqual([expected]);
    expect(sentTo(fromHost.effects, "b")).toEqual([]);

    const fromViewer = onMessage(
      state,
      "a",
      { type: "chat:send", text: "收到！" },
      online,
      T0 + 20,
      { generateId: () => "msg-2" },
    );
    expect(sentTo(fromViewer.effects, "host")).toEqual([
      {
        type: "chat:message",
        id: "msg-2",
        memberId: "a",
        nickname: "A",
        role: "member",
        text: "收到！",
        sentAt: T0 + 20,
      },
    ]);
  });

  test("被踢或非房間成員送 chat:send：關閉連線，不廣播", () => {
    const state = roomWith();
    const kicked = onMessage(
      state,
      "host",
      { type: "room:kick", memberId: "a" },
      online,
      T0,
    ).state;
    const outcome = onMessage(
      kicked,
      "a",
      { type: "chat:send", text: "我還想講話" },
      new Set(["host", "a"]),
      T0 + 1,
    );
    expect(sentTo(outcome.effects, "host")).toEqual([]);
    expect(outcome.effects).toEqual([
      {
        kind: "close",
        to: { memberId: "a" },
        code: CLOSE.UNAUTHORIZED,
        reason: "unknown_member",
      },
    ]);
  });

  test("超過聊天限流：拒絕並不廣播（帶 reqId 回 ack、不帶回 error）", () => {
    const state = roomWith();
    const limiter = new ChatRateLimiter({ limit: 2, windowMs: 10_000 });
    onMessage(state, "a", { type: "chat:send", text: "1" }, online, T0, {
      chatLimiter: limiter,
    });
    onMessage(state, "a", { type: "chat:send", text: "2" }, online, T0 + 100, {
      chatLimiter: limiter,
    });

    const withReq = onMessage(
      state,
      "a",
      { type: "chat:send", reqId: "r3", text: "3" },
      online,
      T0 + 200,
      { chatLimiter: limiter },
    );
    expect(sentTo(withReq.effects, "a")).toEqual([
      { type: "ack", reqId: "r3", ok: false, code: "RATE_LIMITED" },
    ]);
    expect(sentTo(withReq.effects, "host")).toEqual([]);

    const withoutReq = onMessage(
      state,
      "a",
      { type: "chat:send", text: "4" },
      online,
      T0 + 300,
      { chatLimiter: limiter },
    );
    expect(sentTo(withoutReq.effects, "a")[0]).toMatchObject({
      type: "error",
      code: "RATE_LIMITED",
    });
    expect(sentTo(withoutReq.effects, "host")).toEqual([]);
  });
});

describe("onDisconnect", () => {
  test("房主斷線：直播中止並通知收看者", () => {
    const outcome = onDisconnect(
      roomWith({ stream: LIVE, idleSince: null }),
      "host",
      new Set(["a"]),
      T0 + 1,
    );
    expect(outcome.state.stream.live).toBe(false);
    expect(typesTo(outcome.effects, "a")).toEqual([
      "room:members",
      "stream:status",
    ]);
  });

  test("最後一人離線：開始閒置計時", () => {
    const outcome = onDisconnect(
      roomWith({ idleSince: null }),
      "a",
      new Set(),
      T0 + 7,
    );
    expect(outcome.state.idleSince).toBe(T0 + 7);
  });

  test("同一成員仍有其他連線：不視為離線", () => {
    const state = roomWith({ idleSince: null });
    expect(onDisconnect(state, "a", new Set(["a"]), T0)).toEqual({
      state,
      effects: [],
    });
  });

  test("房主斷線記錄 hostDisconnectedAt（可指定 offlineAt）", () => {
    const outcome = onDisconnect(
      roomWith({ idleSince: null, hostDisconnectedAt: null }),
      "host",
      new Set(["a"]),
      T0 + 60,
      T0 + 5,
    );
    expect(outcome.state.hostDisconnectedAt).toBe(T0 + 5);
    expect(outcome.state.members[0]?.lastSeenAt).toBe(T0 + 5);
  });
});

describe("onHostOfflineTimeout 與無房主房間", () => {
  const config = { hostOfflineTtlMs: 100_000 };

  test("房主仍在線或離線未滿期限：不動作", () => {
    const onlineHost = roomWith({ idleSince: null, hostDisconnectedAt: null });
    expect(
      onHostOfflineTimeout(
        onlineHost,
        new Set(["host", "a"]),
        T0 + 200_000,
        config,
      ).removed,
    ).toBe(false);

    const offlineHost = roomWith({ idleSince: null, hostDisconnectedAt: T0 });
    expect(
      onHostOfflineTimeout(
        offlineHost,
        new Set(["a"]),
        T0 + config.hostOfflineTtlMs - 1,
        config,
      ).removed,
    ).toBe(false);
  });

  test("房主離線滿 100 秒：移除房主、停播並廣播給在線收看者", () => {
    const state = roomWith({
      stream: LIVE,
      idleSince: null,
      hostDisconnectedAt: T0,
    });
    const outcome = onHostOfflineTimeout(
      state,
      new Set(["a"]),
      T0 + config.hostOfflineTtlMs,
      config,
    );
    expect(outcome.removed).toBe(true);
    expect(outcome.state.members.map((m) => m.memberId)).toEqual(["a", "b"]);
    expect(outcome.state.hostDisconnectedAt).toBeNull();
    expect(outcome.state.stream.live).toBe(false);
    expect(typesTo(outcome.effects, "a")).toEqual([
      "room:members",
      "stream:status",
    ]);
  });

  test("無房主時收看者送 member:status 或 chat:send 不拋錯", () => {
    const noHost = onHostOfflineTimeout(
      roomWith({ idleSince: null, hostDisconnectedAt: T0 }),
      new Set(["a"]),
      T0 + config.hostOfflineTtlMs,
      config,
    ).state;
    expect(
      onMessage(
        noHost,
        "a",
        { type: "member:status", state: "playing" },
        new Set(["a"]),
        T0 + 100_001,
      ),
    ).toEqual({ state: noHost, effects: [] });

    const chat = onMessage(
      noHost,
      "a",
      { type: "chat:send", text: "還在" },
      new Set(["a"]),
      T0 + 100_002,
      { generateId: () => "m1" },
    );
    expect(typesTo(chat.effects, "a")).toEqual(["chat:message"]);
  });
});

describe("onLeave 與無房主房間", () => {
  test("找不到成員回 null", () => {
    expect(onLeave(roomWith(), "missing", new Set(["host"]), T0)).toBeNull();
  });

  test("收看者明確退房：移除席位、關閉 4401 並廣播給其餘成員", () => {
    const outcome = onLeave(
      roomWith({ idleSince: null }),
      "a",
      new Set(["host", "a"]),
      T0 + 5,
    );
    expect(outcome?.empty).toBe(false);
    expect(outcome?.state.members.map((m) => m.memberId)).toEqual([
      "host",
      "b",
    ]);
    expect(outcome?.effects).toContainEqual({
      kind: "close",
      to: { memberId: "a" },
      code: CLOSE.UNAUTHORIZED,
      reason: "left",
    });
    expect(typesTo(outcome!.effects, "host")).toEqual(["room:members"]);
  });

  test("房主在有收看者時離房：移除房主、停播並保留房間，收看者可繼續聊天", () => {
    const outcome = onLeave(
      roomWith({ stream: LIVE, idleSince: null }),
      "host",
      new Set(["host", "a"]),
      T0 + 5,
    );
    expect(outcome?.empty).toBe(false);
    expect(outcome?.state.members.map((m) => m.memberId)).toEqual(["a", "b"]);
    expect(outcome?.state.stream.live).toBe(false);
    expect(typesTo(outcome!.effects, "a")).toEqual([
      "room:members",
      "stream:status",
    ]);
    expect(
      onMessage(
        outcome!.state,
        "a",
        { type: "member:status", state: "playing" },
        new Set(["a"]),
        T0 + 6,
      ),
    ).toEqual({ state: outcome!.state, effects: [] });
  });

  test("最後一位成員離房回傳 empty: true", () => {
    const solo = createRoomState({
      roomId: "r1",
      inviteCode: "ABCDEFGH",
      host: { memberId: "host", nickname: "房主", tokenHash: "h-host" },
      now: T0,
    });
    const outcome = onLeave(solo, "host", new Set(["host"]), T0 + 1);
    expect(outcome?.empty).toBe(true);
    expect(outcome?.state.members).toEqual([]);
  });
});
