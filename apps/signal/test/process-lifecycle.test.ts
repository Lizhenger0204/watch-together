import { describe, expect, test } from "vitest";
import { createRoomState } from "../src/room/room";
import { ChatRateLimiter } from "../src/signaling/chat-rate-limit";
import {
  CLOSE,
  onDisconnect,
  onHostOfflineTimeout,
  onLeave,
  onMessage,
} from "../src/signaling/process";
import { LIVE, T0, roomWith, sentTo, typesTo } from "./process-fixture";

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
