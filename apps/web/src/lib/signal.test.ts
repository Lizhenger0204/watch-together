import { PROTOCOL_VERSION } from "@project/shared";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "./api";
import {
  IDENTITY_CHECK_AFTER_ATTEMPTS,
  SignalDisconnectedError,
  SignalTimeoutError,
} from "./signal";
import { flushMicrotasks, setup, snapshot } from "./signal.fixtures";

describe("SignalClient", () => {
  test("連線後第一則訊息是 auth，收到 snapshot 才算連上", () => {
    const { current, states } = setup();
    current().open();
    expect(current().sent).toEqual([
      {
        type: "auth",
        token: "secret-token",
        protocolVersion: PROTOCOL_VERSION,
      },
    ]);
    expect(states).toEqual(["connecting"]);
    current().receive(snapshot);
    expect(states).toEqual(["connecting", "open"]);
  });

  test("request 依 reqId 對應 ack：成功 resolve、失敗以 ApiError 拒絕", async () => {
    const { client, current, connect } = setup();
    connect();
    const ok = client.request({ type: "room:update", locked: true });
    const bad = client.request({ type: "room:kick", memberId: "x" });
    const [first, second] = current().sent.slice(1) as { reqId: string }[];
    current().receive({ type: "ack", reqId: first!.reqId, ok: true });
    current().receive({
      type: "ack",
      reqId: second!.reqId,
      ok: false,
      code: "FORBIDDEN",
    });
    await expect(ok).resolves.toBeUndefined();
    await expect(bad).rejects.toEqual(new ApiError("FORBIDDEN"));
  });

  test("未連上時 request 立即失敗，send 回傳 false", async () => {
    const { client } = setup();
    expect(client.send({ type: "ping" })).toBe(false);
    await expect(
      client.request({ type: "room:update", locked: true }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("連上後每 20 秒送 ping", () => {
    const { current, connect, advance } = setup();
    connect();
    advance(40_000);
    expect(
      current().sent.filter((m) => (m as { type: string }).type === "ping"),
    ).toHaveLength(2);
  });

  test.each([
    [4000, "replaced"],
    [4001, "room_closed"],
    [4003, "kicked"],
    [4400, "bad_request"],
    [4401, "unauthorized"],
  ])("關閉碼 %i 不重連（%s）", (code, reason) => {
    const { sockets, current, connect, advance, states } = setup();
    connect();
    current().drop(code);
    advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe(`closed:${reason}`);
  });

  test("其他關閉碼以指數退避重連，連上後次數歸零", () => {
    const { sockets, current, connect, advance, states } = setup();
    connect();
    current().drop(1006);
    expect(states.at(-1)).toBe("reconnecting");
    advance(999);
    expect(sockets).toHaveLength(1);
    advance(1); // 第 1 次：1 秒
    expect(sockets).toHaveLength(2);
    current().drop(1006);
    advance(1999);
    expect(sockets).toHaveLength(2);
    advance(1); // 第 2 次：2 秒
    expect(sockets).toHaveLength(3);
    connect();
    expect(states.at(-1)).toBe("open");
    current().drop(1006);
    advance(1000); // 歸零後又是 1 秒
    expect(sockets).toHaveLength(4);
  });

  test("斷線時尚未回應的 request 會被拒絕", async () => {
    const { client, current, connect } = setup();
    connect();
    const pending = client.request({ type: "room:update", locked: true });
    current().drop(1006);
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    // 斷線造成的失敗要能和伺服器拒絕區分（房主換片途中斷線不可取消開播意圖）
    await expect(pending).rejects.toBeInstanceOf(SignalDisconnectedError);
    // 已寫入 socket 才斷線：結果不明，呼叫端要能和「根本沒送出」區分
    await expect(pending).rejects.toMatchObject({ inFlight: true });
  });

  test("未連上就送 request 也是連線中斷；伺服器拒絕則不是", async () => {
    const offline = setup();
    const notSent = offline.client.request({
      type: "room:update",
      locked: true,
    });
    await expect(notSent).rejects.toBeInstanceOf(SignalDisconnectedError);
    await expect(notSent).rejects.toMatchObject({ inFlight: false });

    const { client, current, connect } = setup();
    connect();
    const bad = client.request({ type: "room:kick", memberId: "x" });
    const [ask] = current().sent.slice(1) as { reqId: string }[];
    current().receive({
      type: "ack",
      reqId: ask!.reqId,
      ok: false,
      code: "FORBIDDEN",
    });
    const error = await bad.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SignalDisconnectedError);
  });

  test("stop 後不再重連", () => {
    const { client, sockets, connect, advance, states } = setup();
    connect();
    client.stop();
    advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe("closed:stopped");
  });

  test("ack 逆序回來時仍依 reqId 配對", async () => {
    const { client, current, connect } = setup();
    connect();
    const first = client.request({ type: "room:update", locked: true });
    const second = client.request({ type: "room:kick", memberId: "x" });
    const [a, b] = current().sent.slice(1) as { reqId: string }[];
    current().receive({
      type: "ack",
      reqId: b!.reqId,
      ok: false,
      code: "FORBIDDEN",
    });
    current().receive({ type: "ack", reqId: a!.reqId, ok: true });
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toEqual(new ApiError("FORBIDDEN"));
  });

  test("4408 之後重連並重新 auth", () => {
    const { sockets, current, connect, advance, states } = setup();
    connect();
    current().drop(4408);
    advance(1000);
    expect(sockets).toHaveLength(2);
    current().open();
    expect(current().sent[0]).toMatchObject({ type: "auth" });
    current().receive(snapshot);
    expect(states.at(-1)).toBe("open");
  });

  test.each([
    ["room_closed", "closed:room_closed"],
    ["unauthorized", "closed:unauthorized"],
  ] as const)(
    "連續重連失敗 %i 次且一直沒收到 snapshot：用 REST 確認身份，%s 就停止重連",
    async (result, state) => {
      const verifyIdentity = vi.fn(async () => result);
      const { sockets, current, advance, states } = setup({ verifyIdentity });
      for (let i = 1; i < IDENTITY_CHECK_AFTER_ATTEMPTS; i++) {
        current().drop(1006);
        advance(15_000);
      }
      expect(verifyIdentity).not.toHaveBeenCalled();
      current().drop(1006);
      expect(verifyIdentity).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(states.at(-1)).toBe(state);
      const count = sockets.length;
      advance(60_000);
      expect(sockets).toHaveLength(count);
    },
  );

  test("確認身份仍有效（真的是網路問題）就繼續退避重連", async () => {
    const verifyIdentity = vi.fn(async () => "valid" as const);
    const { sockets, current, advance, states } = setup({ verifyIdentity });
    for (let i = 0; i < IDENTITY_CHECK_AFTER_ATTEMPTS; i++) {
      current().drop(1006);
      advance(15_000);
    }
    await Promise.resolve();
    expect(verifyIdentity).toHaveBeenCalledTimes(1);
    const count = sockets.length;
    current().drop(1006);
    expect(states.at(-1)).toBe("reconnecting");
    advance(15_000);
    expect(sockets).toHaveLength(count + 1);
  });

  test("確認身份途中連上了：忽略結果", async () => {
    let resolve: (v: "unauthorized") => void = () => {};
    const verifyIdentity = vi.fn(
      () => new Promise<"unauthorized">((r) => (resolve = r)),
    );
    const { current, advance, states } = setup({ verifyIdentity });
    for (let i = 0; i < IDENTITY_CHECK_AFTER_ATTEMPTS; i++) {
      current().drop(1006);
      advance(15_000);
    }
    current().open();
    current().receive(snapshot);
    const closed = states.length;
    resolve("unauthorized");
    // 等 verify().catch().then() 整條鏈跑完再斷言，否則還沒處理就先通過。
    await flushMicrotasks();
    expect(verifyIdentity).toHaveBeenCalledTimes(1);
    expect(states.slice(closed)).toEqual([]);
    expect(states.at(-1)).toBe("open");
  });

  test("驗證前就收到 4400：確認身份，token 已無效就當成 4401", async () => {
    const verifyIdentity = vi.fn(async () => "unauthorized" as const);
    const { current, states } = setup({ verifyIdentity });
    current().open();
    current().drop(4400);
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toBe("closed:unauthorized");
  });

  test("驗證前就收到 4400 但身份有效（協定版本不符）：維持要求重新整理", async () => {
    const verifyIdentity = vi.fn(async () => "valid" as const);
    const { current, states } = setup({ verifyIdentity });
    current().open();
    current().drop(4400);
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toBe("closed:bad_request");
  });

  test("驗證後才收到 4400：不查身份，直接要求重新整理", () => {
    const verifyIdentity = vi.fn(async () => "unauthorized" as const);
    const { current, connect, states } = setup({ verifyIdentity });
    connect();
    current().drop(4400);
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("closed:bad_request");
  });

  test("request 逾時以 SignalTimeoutError 拒絕；伺服器回 ack ok:false（含 INTERNAL）則是一般 ApiError", async () => {
    const { client, current, connect, advance } = setup({
      requestTimeoutMs: 5_000,
    });
    connect();

    const timedOutReq = client.request({ type: "room:update", mode: "relay" });
    advance(4_999);
    const rejectedReq = client.request({ type: "room:update", locked: true });
    const [, second] = current().sent.slice(1) as { reqId: string }[];
    current().receive({
      type: "ack",
      reqId: second!.reqId,
      ok: false,
      code: "INTERNAL",
    });
    advance(1);

    const timeoutErr = await timedOutReq.catch((e: unknown) => e);
    expect(timeoutErr).toBeInstanceOf(SignalTimeoutError);
    expect(timeoutErr).toBeInstanceOf(ApiError);
    expect(timeoutErr).not.toBeInstanceOf(SignalDisconnectedError);
    expect((timeoutErr as ApiError).code).toBe("INTERNAL");

    const rejectedErr = await rejectedReq.catch((e: unknown) => e);
    expect(rejectedErr).toBeInstanceOf(ApiError);
    expect(rejectedErr).not.toBeInstanceOf(SignalTimeoutError);
    expect(rejectedErr).not.toBeInstanceOf(SignalDisconnectedError);
    expect((rejectedErr as ApiError).code).toBe("INTERNAL");
  });
});
