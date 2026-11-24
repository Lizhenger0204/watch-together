import type {
  ClientMessageOf,
  Member,
  Mode,
  Quality,
  ServerMessage,
} from "@project/shared";
import { expect, vi } from "vitest";
import type { ConnectionState } from "../../lib/signal";
import {
  TransportError,
  type CreateHostTransport,
  type HostTransport,
  type HostTransportOptions,
  type HostTransportState,
} from "../transport";
import { HostSession } from "./host-session";
import type { HostSessionClient, HostSource } from "./host-session-types";

// host-session 測試共用的替身與 setup。真正的 describe／test 在各自的 *.test.ts。

export type Request = Parameters<HostSessionClient["request"]>[0];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** 讓 await 鏈跑完（不經過計時器）。 */
export async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

export function label(message: Request) {
  if (message.type === "stream:status") {
    return message.live
      ? `stream:status live ${message.title}`
      : "stream:status off";
  }
  const parts = Object.entries(message)
    .filter(([key]) => key !== "type")
    .map(([key, value]) => `${key}=${String(value)}`);
  return `room:update ${parts.join(" ")}`;
}

export class FakeClient implements HostSessionClient {
  readonly requests: {
    message: Request;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  readonly sent: ClientMessageOf<"signal">[] = [];
  private readonly messageHandlers = new Set<(m: ServerMessage) => void>();
  private readonly stateHandlers = new Set<(s: ConnectionState) => void>();

  constructor(private readonly log: string[]) {}

  onMessage(handler: (message: ServerMessage) => void) {
    this.messageHandlers.add(handler);
    return () => void this.messageHandlers.delete(handler);
  }
  onState(handler: (state: ConnectionState) => void) {
    this.stateHandlers.add(handler);
    return () => void this.stateHandlers.delete(handler);
  }
  send(message: ClientMessageOf<"signal">) {
    this.sent.push(message);
    return true;
  }
  request(message: Request) {
    this.log.push(label(message));
    return new Promise<void>((resolve, reject) => {
      this.requests.push({ message, resolve, reject });
    });
  }

  emit(message: ServerMessage) {
    this.messageHandlers.forEach((handler) => handler(message));
  }
  state(state: ConnectionState) {
    this.stateHandlers.forEach((handler) => handler(state));
  }
  /** 回最後一筆符合的請求（預設成功）。 */
  async ack(match: string, error?: unknown) {
    const index = this.requests.map((r) => label(r.message)).lastIndexOf(match);
    if (index < 0) throw new Error(`沒有送出 ${match}`);
    const [entry] = this.requests.splice(index, 1);
    if (error) entry!.reject(error);
    else entry!.resolve();
    await flush();
  }
}

export class FakeTransport implements HostTransport {
  readonly mode: Mode;
  readonly stream: MediaStream;
  readonly gate = deferred();
  readonly setQualityResult = { error: null as unknown };
  private readonly stateHandlers = new Set<(s: HostTransportState) => void>();
  private readonly errorHandlers = new Set<(e: TransportError) => void>();

  constructor(
    readonly options: HostTransportOptions,
    private readonly log: string[],
  ) {
    this.mode = options.mode;
    this.stream = options.stream;
  }

  start() {
    this.log.push("start");
    return this.gate.promise;
  }
  stop() {
    this.log.push("stop");
  }
  destroy() {
    this.log.push("destroy");
    this.stateHandlers.clear();
    this.errorHandlers.clear();
  }
  replaceTrack(kind: "video" | "audio", track: MediaStreamTrack | null) {
    this.log.push(`replace ${kind} ${track?.id ?? "null"}`);
  }
  setQuality(quality: Quality) {
    this.log.push(`setQuality ${quality}`);
    const { error } = this.setQualityResult;
    return error ? Promise.reject(error) : Promise.resolve();
  }
  removePeer(memberId: string) {
    this.log.push(`removePeer ${memberId}`);
  }
  onState(handler: (state: HostTransportState) => void) {
    this.stateHandlers.add(handler);
    return () => void this.stateHandlers.delete(handler);
  }
  onPeerState() {
    return () => {};
  }
  onStats() {
    return () => {};
  }
  onError(handler: (error: TransportError) => void) {
    this.errorHandlers.add(handler);
    return () => void this.errorHandlers.delete(handler);
  }
  emitState(state: HostTransportState) {
    this.stateHandlers.forEach((handler) => handler(state));
  }
  emitError(error: TransportError) {
    this.errorHandlers.forEach((handler) => handler(error));
  }
}

export function fakeTrack(kind: "video" | "audio", id: string) {
  return { id, kind, readyState: "live" } as unknown as MediaStreamTrack;
}

export class FakeStream {
  private tracks: MediaStreamTrack[];
  constructor(...tracks: MediaStreamTrack[]) {
    this.tracks = tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  add(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  remove(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

export const asStream = (stream: FakeStream) =>
  stream as unknown as MediaStream;

export function readySource(
  stream = new FakeStream(fakeTrack("video", "v1"), fakeTrack("audio", "a1")),
  title = "電影",
): HostSource {
  return { stream: asStream(stream), status: "ready", title };
}

export const host: Member = {
  memberId: "host",
  nickname: "房主",
  role: "host",
  online: true,
};
export const viewer = (memberId: string, online = true): Member => ({
  memberId,
  nickname: memberId,
  role: "member",
  online,
});

export function snapshot(
  patch: { mode?: Mode; quality?: Quality; members?: Member[] } = {},
): ServerMessage {
  return {
    type: "room:snapshot",
    room: {
      roomId: "room",
      locked: false,
      mode: patch.mode ?? "p2p",
      quality: patch.quality ?? "standard",
      createdAt: 1,
      inviteCode: "ABCD-EFGH",
    },
    members: patch.members ?? [host, viewer("v1")],
    stream: { live: false, title: null, startedAt: null },
    you: { memberId: "host", role: "host" },
  };
}

export function roomUpdated(
  mode: Mode,
  quality: Quality = "standard",
): ServerMessage {
  return {
    type: "room:updated",
    room: { roomId: "room", locked: false, mode, quality, createdAt: 1 },
  };
}

export function setup(
  options: { intent?: boolean; createTransport?: CreateHostTransport } = {},
) {
  const log: string[] = [];
  const client = new FakeClient(log);
  const transports: FakeTransport[] = [];
  const factory: CreateHostTransport = (opts) => {
    log.push(`create ${opts.mode}`);
    const transport = new FakeTransport(opts, log);
    transports.push(transport);
    return transport;
  };
  const onIntentChange = vi.fn();
  const session = new HostSession({
    client,
    roomId: "room",
    token: "host-token",
    initialIntent: options.intent ?? true,
    onIntentChange,
    createTransport: options.createTransport ?? factory,
  });
  const detach = session.attach();
  const connect = (message = snapshot()) => {
    client.state({ status: "open" });
    client.emit(message);
  };
  /** 連上、片源就緒、start 完成、live:true 被確認。 */
  const goLive = async (source = readySource()) => {
    connect();
    session.setSource(source);
    transports.at(-1)!.gate.resolve();
    await flush();
    await client.ack(`stream:status live ${source.title}`);
    expect(session.getView().phase).toBe("live");
    log.length = 0;
    return transports.at(-1)!;
  };
  return {
    log,
    client,
    transports,
    session,
    detach,
    onIntentChange,
    connect,
    goLive,
  };
}
