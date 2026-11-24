import {
  JOIN_MAX_BODY_BYTES,
  JOIN_MAX_EXCLUDED_ROOMS,
  createRoomResponseSchema,
} from "@project/shared";
import { env } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { errorBody } from "../src/errors";
import { workersServices } from "../src/runtime/workers/services";

const app = createApp((c) => ({
  ...workersServices(c),
  joinLimiter: { allow: async () => true },
}));
function post(path: string, body: BodyInit, headers?: Record<string, string>) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    },
    env,
  );
}

async function room() {
  const res = await post("/api/rooms", JSON.stringify({ nickname: "房主" }));
  return createRoomResponseSchema.parse(await res.json());
}
const joinPath = "/api/rooms/join";

test("16 個房號與 2,048 位元組可加入，超出任一上限都回 400", async () => {
  const { inviteCode } = await room();
  const excludeRoomIds = Array.from({ length: JOIN_MAX_EXCLUDED_ROOMS }, () =>
    crypto.randomUUID(),
  );
  const input = { nickname: "朋友", inviteCode, excludeRoomIds };
  const json = JSON.stringify(input);
  const exact =
    json +
    " ".repeat(JOIN_MAX_BODY_BYTES - new TextEncoder().encode(json).byteLength);
  expect((await post(joinPath, exact)).status).toBe(200);
  for (const excess of [
    exact + " ",
    JSON.stringify({
      ...input,
      excludeRoomIds: [...excludeRoomIds, crypto.randomUUID()],
    }),
  ]) {
    const res = await post(joinPath, excess);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(errorBody("BAD_REQUEST"));
  }
});

test("串流累計超限即取消讀取，短的 Content-Length 也不會略過實際位元組檢查", async () => {
  const cancel = vi.fn();
  const chunks = [new Uint8Array(JOIN_MAX_BODY_BYTES), new Uint8Array(1)];
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  );
  const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  const res = await post(joinPath, body, { "Content-Length": "1" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual(errorBody("BAD_REQUEST"));
  expect(pull).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledOnce();
});

test("滿房時排除名單命中與未命中的狀態和本文相同", async () => {
  const { roomId, inviteCode } = await room();
  const input = { inviteCode, nickname: "朋友" };
  for (let i = 0; i < 7; i++) {
    expect((await post(joinPath, JSON.stringify(input))).status).toBe(200);
  }
  const responses = [];
  for (const id of [roomId, crypto.randomUUID()]) {
    const res = await post(
      joinPath,
      JSON.stringify({ ...input, excludeRoomIds: [id] }),
    );
    responses.push({ status: res.status, body: await res.text() });
  }
  expect(responses[0]).toEqual(responses[1]);
  expect(responses[0]?.status).toBe(409);
  expect(JSON.parse(responses[0]!.body)).toEqual(errorBody("ROOM_FULL"));
});

test("大寫房號同樣排除新席位，也能沿用原身份", async () => {
  const { roomId, memberId, hostToken, inviteCode } = await room();
  const upper = roomId.toUpperCase();
  const input = { inviteCode, nickname: "朋友" };
  const excluded = await post(
    joinPath,
    JSON.stringify({ ...input, excludeRoomIds: [upper] }),
  );
  expect(excluded.status).toBe(404);
  expect(await excluded.json()).toEqual(errorBody("ROOM_NOT_FOUND"));
  const reused = await post(
    joinPath,
    JSON.stringify({ ...input, existingRoomId: upper }),
    {
      Authorization: `Bearer ${hostToken}`,
    },
  );
  expect(reused.status).toBe(200);
  expect(await reused.json()).toEqual({ roomId, memberId, reused: true });
});
