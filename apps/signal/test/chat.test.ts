import { CHAT_MAX_LENGTH, CHAT_RATE_LIMIT_MAX } from "@project/shared";
import { describe, expect, test } from "vitest";
import { connect, createRoom, hostSocket, joinRoom } from "./room-fixture";

describe("WebSocket 聊天室（T-127）", () => {
  test("房主與收看者可互發訊息，不保留歷史紀錄", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);

    // 收看者還沒加入前，房主先發一則訊息。
    host.send({ type: "chat:send", reqId: "h0", text: "開場前的話" });
    expect(await host.next("ack")).toEqual({
      type: "ack",
      reqId: "h0",
      ok: true,
    });
    expect(await host.next("chat:message")).toMatchObject({
      memberId: room.memberId,
      nickname: "房主",
      role: "host",
      text: "開場前的話",
    });

    // 晚加入的收看者看不到先前的訊息，只收得到之後的訊息。
    const joined = await joinRoom(room.inviteCode, "小美");
    const viewer = await connect(room.roomId);
    viewer.auth(joined.memberToken);
    const snapshot = await viewer.next("room:snapshot");
    expect(snapshot).not.toHaveProperty("messages");

    viewer.send({ type: "chat:send", reqId: "v1", text: "  哈囉\n大家  " });
    expect(await viewer.next("ack")).toEqual({
      type: "ack",
      reqId: "v1",
      ok: true,
    });
    const viewerMsg = await host.next("chat:message");
    expect(viewerMsg).toMatchObject({
      memberId: joined.memberId,
      nickname: "小美",
      role: "member",
      text: "哈囉 大家",
    });
    expect(await viewer.next("chat:message")).toEqual(viewerMsg);

    host.close();
    viewer.close();
  });

  test("未驗證連線送 chat:send 會以 4400 關閉", async () => {
    const room = await createRoom();
    const ws = await connect(room.roomId);
    ws.send({ type: "chat:send", text: "偷跑" });
    expect(await ws.closedWith()).toBe(4400);
  });

  test("空訊息與超過長度上限回 BAD_REQUEST，不廣播", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);

    host.send({ type: "chat:send", text: "   " });
    expect(await host.next("error")).toMatchObject({ code: "BAD_REQUEST" });

    host.send({ type: "chat:send", text: "字".repeat(CHAT_MAX_LENGTH + 1) });
    expect(await host.next("error")).toMatchObject({ code: "BAD_REQUEST" });

    host.close();
  });

  test("超過聊天限流回 RATE_LIMITED，不廣播", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);
    const joined = await joinRoom(room.inviteCode, "小華");
    const viewer = await connect(room.roomId);
    viewer.auth(joined.memberToken);
    await viewer.next("room:snapshot");

    for (let i = 1; i <= CHAT_RATE_LIMIT_MAX; i++) {
      viewer.send({ type: "chat:send", reqId: `m${i}`, text: `第 ${i} 則` });
      expect(await viewer.next("ack")).toEqual({
        type: "ack",
        reqId: `m${i}`,
        ok: true,
      });
      await viewer.next("chat:message");
      await host.next("chat:message");
    }

    viewer.send({ type: "chat:send", reqId: "over", text: "太快了" });
    expect(await viewer.next("ack")).toEqual({
      type: "ack",
      reqId: "over",
      ok: false,
      code: "RATE_LIMITED",
    });

    // 房主有自己獨立的限流額度，仍能正常發言。
    host.send({ type: "chat:send", reqId: "h-ok", text: "房主說話" });
    expect(await host.next("ack")).toEqual({
      type: "ack",
      reqId: "h-ok",
      ok: true,
    });
    expect((await viewer.next("chat:message")).text).toBe("房主說話");

    host.close();
    viewer.close();
  });

  test("被踢出的成員不能再發言", async () => {
    const room = await createRoom();
    const host = await hostSocket(room);
    const joined = await joinRoom(room.inviteCode, "路人");
    const viewer = await connect(room.roomId);
    viewer.auth(joined.memberToken);
    await viewer.next("room:snapshot");

    host.send({ type: "room:kick", reqId: "k1", memberId: joined.memberId });
    expect(await host.next("ack")).toEqual({
      type: "ack",
      reqId: "k1",
      ok: true,
    });
    expect(await viewer.closedWith()).toBe(4003);

    // 拿舊 token 重連也會在驗證階段被 4401 拒絕，無法發言。
    const retry = await connect(room.roomId);
    retry.auth(joined.memberToken);
    expect(await retry.closedWith()).toBe(4401);

    host.close();
  });
});
