import {
  PROTOCOL_VERSION,
  createRoomResponseSchema,
  joinRoomResponseSchema,
  parseServerMessage,
  type CreateRoomResponse,
  type Mode,
  type ServerMessage,
} from "@project/shared";
import {
  SELF,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { expect, vi } from "vitest";
import type { RoomDO } from "../src/runtime/workers/room-do";

export const BASE = "https://signal.test";

export function post(path: string, body?: unknown, token?: string) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.0.0.${Math.floor(Math.random() * 250)}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function createRoom() {
  const res = await post("/api/rooms", { nickname: "房主" });
  expect(res.status).toBe(201);
  return createRoomResponseSchema.parse(await res.json());
}

export async function joinRoom(inviteCode: string, nickname = "朋友") {
  const res = await post("/api/rooms/join", { inviteCode, nickname });
  expect(res.status).toBe(200);
  return joinRoomResponseSchema.parse(await res.json());
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export async function alarmTime(stub: DurableObjectStub<RoomDO>) {
  return runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
}

/** 把時鐘撥到 `now` 再執行已排定的 alarm。 */
export async function runAlarmAt(stub: DurableObjectStub<RoomDO>, now: number) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    return await runDurableObjectAlarm(stub);
  } finally {
    clock.mockRestore();
  }
}

/** 開 WebSocket，收集伺服器訊息，提供 next(type) 等待特定訊息。 */
export async function connect(roomId: string) {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`沒有 WebSocket（status ${res.status}）`);
  ws.accept();

  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  let closed: { code: number } | null = null;
  ws.addEventListener("message", (event) => {
    const parsed = parseServerMessage(event.data as string);
    if (!parsed.ok) throw new Error(parsed.error);
    inbox.push(parsed.message);
    waiters.splice(0).forEach((wake) => wake());
  });
  ws.addEventListener("close", (event) => {
    closed = { code: event.code };
    waiters.splice(0).forEach((wake) => wake());
  });

  async function next<T extends ServerMessage["type"]>(type: T) {
    for (;;) {
      const index = inbox.findIndex((m) => m.type === type);
      if (index >= 0) {
        return inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
      }
      if (closed)
        throw new Error(`連線已關閉（${closed.code}），沒有收到 ${type}`);
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }
  async function closedWith() {
    while (!closed) await new Promise<void>((resolve) => waiters.push(resolve));
    return closed.code;
  }

  return {
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    auth: (token: string) =>
      ws.send(
        JSON.stringify({
          type: "auth",
          token,
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    next,
    closedWith,
    close: () => ws.close(1000),
  };
}

export async function hostSocket(room: CreateRoomResponse) {
  const host = await connect(room.roomId);
  host.auth(room.hostToken);
  await host.next("room:snapshot");
  return host;
}

export async function setMode(
  host: Awaited<ReturnType<typeof connect>>,
  mode: Mode,
) {
  host.send({ type: "room:update", mode, reqId: "mode" });
  expect(await host.next("ack")).toMatchObject({ reqId: "mode", ok: true });
}

export async function relayRoom() {
  const room = await createRoom();
  const host = await hostSocket(room);
  await setMode(host, "relay");
  return { ...room, host };
}
