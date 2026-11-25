import {
  DEFAULT_QUALITY,
  type MemberState,
  type Mode,
  type ServerMessage,
  type ServerMessageOf,
  type SignalData,
} from "@project/shared";
import { vi } from "vitest";
import {
  Emitter,
  type TransportError,
  type TransportStats,
  type ViewerTransport,
  type ViewerTransportOptions,
} from "../transport";
import { ViewerSession, type ViewerSessionClient } from "./viewer-session";

// viewer-session 測試共用的替身與 setup。真正的 describe／test 在各自的 *.test.ts。

export const HOST = "host-1";

export function snapshot(
  opts: { live?: boolean; mode?: Mode; role?: "host" | "member" } = {},
): ServerMessageOf<"room:snapshot"> {
  return {
    type: "room:snapshot",
    room: {
      roomId: "r",
      locked: false,
      mode: opts.mode ?? "p2p",
      quality: DEFAULT_QUALITY,
      createdAt: 0,
    },
    members: [],
    stream: opts.live
      ? { live: true, title: "電影", startedAt: 1 }
      : { live: false, title: null, startedAt: null },
    you: { memberId: "m1", role: opts.role ?? "member" },
  };
}

export const live = (on: boolean): ServerMessage =>
  on
    ? { type: "stream:status", live: true, title: "電影", startedAt: 1 }
    : { type: "stream:status", live: false, title: null, startedAt: null };

export const modeUpdate = (mode: Mode): ServerMessage => ({
  type: "room:updated",
  room: snapshot({ mode }).room,
});

export const offer = (id: string): SignalData => ({
  type: "offer",
  negotiationId: id,
  sdp: "v=0",
});

export const signal = (data: SignalData): ServerMessage => ({
  type: "signal",
  from: HOST,
  data,
});

export class FakeTransport implements ViewerTransport {
  readonly remoteStream = { id: crypto.randomUUID() } as MediaStream;
  readonly events = new Emitter<{
    state: [MemberState];
    stats: [TransportStats];
    error: [TransportError];
  }>();
  received: { from: string; data: SignalData }[] = [];
  destroyed = false;
  private resolveStart!: () => void;
  private rejectStart!: (error: unknown) => void;
  readonly started = new Promise<void>((resolve, reject) => {
    this.resolveStart = resolve;
    this.rejectStart = reject;
  });

  constructor(
    readonly mode: Mode,
    readonly options: ViewerTransportOptions,
  ) {}

  start = vi.fn(() => {
    this.options.signal.onSignal((message) => this.received.push(message));
    return this.started;
  });
  /** 讓 start() resolve，並等 then 回呼跑完。 */
  async ready() {
    this.resolveStart();
    await Promise.resolve();
    await Promise.resolve();
  }
  async failStart(error: unknown) {
    this.rejectStart(error);
    await Promise.resolve();
    await Promise.resolve();
  }
  stop() {}
  destroy() {
    this.destroyed = true;
  }
  onState = (h: (s: MemberState) => void) => this.events.on("state", h);
  onStats = (h: (s: TransportStats) => void) => this.events.on("stats", h);
  onError = (h: (e: TransportError) => void) => this.events.on("error", h);
}

export function setup() {
  const handlers = new Set<(m: ServerMessage) => void>();
  const sent: Parameters<ViewerSessionClient["send"]>[0][] = [];
  const client: ViewerSessionClient = {
    onState: () => () => {},
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    send: (m) => {
      sent.push(m);
      return true;
    },
  };
  const transports: FakeTransport[] = [];
  const requestNewSocket = vi.fn();
  const createTransport = vi.fn((options: ViewerTransportOptions) => {
    const t = new FakeTransport(options.mode, options);
    transports.push(t);
    return t;
  });
  const session = new ViewerSession({
    client,
    roomId: "r",
    token: "member-token",
    requestNewSocket,
    createTransport,
  });
  const detach = session.attach();
  const receive = (m: ServerMessage) => handlers.forEach((h) => h(m));
  const statuses = () =>
    sent.filter((m) => m.type === "member:status").map((m) => m.state);
  return {
    session,
    detach,
    receive,
    sent,
    statuses,
    transports,
    createTransport,
    requestNewSocket,
    last: () => transports[transports.length - 1]!,
  };
}
