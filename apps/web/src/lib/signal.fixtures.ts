import { DEFAULT_QUALITY } from "@project/shared";
import { vi } from "vitest";
import {
  SignalClient,
  type SignalClientOptions,
  type SocketLike,
  type Timers,
} from "./signal";

export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close = vi.fn();
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<
    number,
    { at: number; fn: () => void; every?: number }
  >();
  const timers: Timers = {
    setTimeout: (fn, ms) => (tasks.set(nextId, { at: now + ms, fn }), nextId++),
    clearTimeout: (id) => tasks.delete(id as number),
    setInterval: (fn, ms) => (
      tasks.set(nextId, { at: now + ms, fn, every: ms }),
      nextId++
    ),
    clearInterval: (id) => tasks.delete(id as number),
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...tasks]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      now = task.at;
      if (task.every) task.at += task.every;
      else tasks.delete(id);
      task.fn();
    }
    now = end;
  }
  return { timers, advance };
}

export const snapshot = {
  type: "room:snapshot",
  room: {
    roomId: "r",
    locked: false,
    mode: "p2p",
    quality: DEFAULT_QUALITY,
    createdAt: 0,
  },
  members: [],
  stream: { live: false, title: null, startedAt: null },
  you: { memberId: "m", role: "host" },
};

export async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export function setup(options: Partial<SignalClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const { timers, advance } = fakeTimers();
  const client = new SignalClient({
    url: "ws://test",
    token: "secret-token",
    timers,
    random: () => 1,
    ...options,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const states: string[] = [];
  client.onState((s) =>
    states.push(s.status === "closed" ? `closed:${s.reason}` : s.status),
  );
  client.start();
  const current = () => sockets[sockets.length - 1]!;
  const connect = () => {
    current().open();
    current().receive(snapshot);
  };
  return { client, sockets, current, connect, advance, states };
}
