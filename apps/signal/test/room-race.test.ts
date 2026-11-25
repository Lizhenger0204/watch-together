import { PROTOCOL_VERSION } from "@project/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { RoomState } from "../src/room/room";
import {
  connect,
  createRoom,
  deferred,
  hostSocket,
  joinRoom,
  setMode,
} from "./room-fixture";

/** 第一個操作已決定要寫的狀態，但尚未進入 storage 交易；此時送入第二個事件。 */
async function overlap<T>(
  storage: DurableObjectStorage,
  first: () => Promise<T>,
  second: () => Promise<void>,
) {
  const entered = deferred();
  const resume = deferred();
  const committed = deferred();
  const transact = storage.transaction.bind(storage);
  const gate = vi
    .spyOn(storage, "transaction")
    .mockImplementationOnce(async (work) => {
      entered.resolve();
      await resume.promise;
      try {
        return await transact(work);
      } finally {
        committed.resolve();
      }
    })
    .mockImplementationOnce(async (work) => {
      // 固定交易提交順序，讓第二個操作若帶著舊清單就一定會覆蓋第一筆。
      await committed.promise;
      return transact(work);
    });
  try {
    const pending = first();
    await entered.promise;
    const next = second();
    resume.resolve();
    const [result] = await Promise.all([pending, next]);
    return result;
  } finally {
    resume.resolve();
    gate.mockRestore();
  }
}

test("加入提交前收到踢人，成功加入的席位保留，被踢者不能回房", async () => {
  const room = await createRoom();
  const kicked = await joinRoom(room.inviteCode);
  const host = await hostSocket(room);
  const stub = env.ROOM.getByName(room.roomId);
  await runInDurableObject(stub, async (instance, state) => {
    const joined = await overlap(
      state.storage,
      () => instance.join({ inviteCode: room.inviteCode, nickname: "新人" }),
      () =>
        instance.webSocketMessage(
          state.getWebSockets()[0]!,
          JSON.stringify({
            type: "room:kick",
            memberId: kicked.memberId,
            reqId: "kick",
          }),
        ),
    );
    if (!joined.ok) throw new Error("新人加入失敗");
    expect((await instance.authenticate(joined.value.memberToken)).ok).toBe(
      true,
    );
    expect((await instance.authenticate(kicked.memberToken)).ok).toBe(false);
    const saved = await state.storage.get<RoomState>("state");
    expect(saved?.members.map((m) => m.memberId)).toEqual([
      room.memberId,
      joined.value.memberId,
    ]);
  });
  expect(await host.next("ack")).toMatchObject({ reqId: "kick", ok: true });
  host.close();
});

test("模式提交前收到開播，依序確認兩則訊息並保留兩項變更", async () => {
  const room = await createRoom();
  const host = await hostSocket(room);
  await runInDurableObject(
    env.ROOM.getByName(room.roomId),
    async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      await overlap(
        state.storage,
        () =>
          instance.webSocketMessage(
            ws,
            JSON.stringify({
              type: "room:update",
              mode: "relay",
              reqId: "mode",
            }),
          ),
        () =>
          instance.webSocketMessage(
            ws,
            JSON.stringify({
              type: "stream:status",
              live: true,
              title: "電影",
              reqId: "live",
            }),
          ),
      );
      const saved = await state.storage.get<RoomState>("state");
      expect({ mode: saved?.mode, live: saved?.stream.live }).toEqual({
        mode: "relay",
        live: true,
      });
    },
  );
  expect(await host.next("ack")).toMatchObject({ reqId: "mode", ok: true });
  expect(await host.next("ack")).toMatchObject({ reqId: "live", ok: true });
  host.close();
});

test("新人加入淘汰逾期席位時另一人離線，保留新席位與離線者的新 relay 世代", async () => {
  const room = await createRoom();
  const expired = await joinRoom(room.inviteCode);
  const member = await joinRoom(room.inviteCode);
  const host = await hostSocket(room);
  await setMode(host, "relay");
  const viewer = await connect(room.roomId);
  viewer.auth(member.memberToken);
  await viewer.next("room:snapshot");

  await runInDurableObject(
    env.ROOM.getByName(room.roomId),
    async (instance, state) => {
      const ws = state
        .getWebSockets()
        .find(
          (socket) =>
            socket.deserializeAttachment()?.memberId === member.memberId,
        )!;
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + 11 * 60_000);
      try {
        const joined = await overlap(
          state.storage,
          () =>
            instance.join({ inviteCode: room.inviteCode, nickname: "新人" }),
          () => instance.webSocketClose(ws, 1000),
        );
        if (!joined.ok) throw new Error("新人加入失敗");
        expect((await instance.authenticate(expired.memberToken)).ok).toBe(
          false,
        );
        expect((await instance.authenticate(joined.value.memberToken)).ok).toBe(
          true,
        );
        expect(await instance.authenticate(member.memberToken)).toMatchObject({
          ok: true,
          value: { relayGeneration: 1 },
        });
      } finally {
        clock.mockRestore();
      }
    },
  );
  host.close();
});

test("房主接手的交易失敗時保留原連線與直播，重試成功才以 4000 取代", async () => {
  const room = await createRoom();
  const host = await hostSocket(room);
  host.send({
    type: "stream:status",
    live: true,
    title: "電影",
    reqId: "live",
  });
  expect(await host.next("ack")).toMatchObject({ reqId: "live", ok: true });
  const replacement = await connect(room.roomId);
  await runInDurableObject(
    env.ROOM.getByName(room.roomId),
    async (instance, state) => {
      const ws = state
        .getWebSockets()
        .find((socket) => socket.deserializeAttachment()?.memberId === null)!;
      const fail = vi
        .spyOn(state.storage, "transaction")
        .mockRejectedValueOnce(new Error("提交失敗"));
      try {
        await expect(
          instance.webSocketMessage(
            ws,
            JSON.stringify({
              type: "auth",
              token: room.hostToken,
              protocolVersion: PROTOCOL_VERSION,
            }),
          ),
        ).rejects.toThrow("提交失敗");
      } finally {
        fail.mockRestore();
      }
      expect((await state.storage.get<RoomState>("state"))?.stream.live).toBe(
        true,
      );
    },
  );
  host.send({ type: "ping" });
  expect((await host.next("pong")).type).toBe("pong");
  replacement.auth(room.hostToken);
  expect((await replacement.next("room:snapshot")).stream.live).toBe(false);
  expect(await host.closedWith()).toBe(4000);
  replacement.close();
});
