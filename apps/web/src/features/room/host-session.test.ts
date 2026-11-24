import type {
  ClientMessageOf,
  Member,
  Mode,
  Quality,
  ServerMessage,
} from "@project/shared";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import {
  SignalDisconnectedError,
  type ConnectionState,
} from "../../lib/signal";
import {
  createHostTransport,
  TransportError,
  type CreateHostTransport,
  type HostTransport,
  type HostTransportOptions,
  type HostTransportState,
} from "../transport";
import { createFakePeerConnectionFactory } from "../transport/common/rtc-fake";
import {
  flush as flushTimers,
  track as rtcTrack,
  useRtcFakes,
} from "../transport/p2p/test-fixtures";
import {
  HostSession,
  type HostSessionClient,
  type HostSource,
} from "./host-session";

// ── 測試替身 ─────────────────────────────────────────────

type Request = Parameters<HostSessionClient["request"]>[0];

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
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function label(message: Request) {
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

class FakeClient implements HostSessionClient {
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

class FakeTransport implements HostTransport {
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

function fakeTrack(kind: "video" | "audio", id: string) {
  return { id, kind, readyState: "live" } as unknown as MediaStreamTrack;
}

class FakeStream {
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

const asStream = (stream: FakeStream) => stream as unknown as MediaStream;

function readySource(
  stream = new FakeStream(fakeTrack("video", "v1"), fakeTrack("audio", "a1")),
  title = "電影",
): HostSource {
  return { stream: asStream(stream), status: "ready", title };
}

const host: Member = {
  memberId: "host",
  nickname: "房主",
  role: "host",
  online: true,
};
const viewer = (memberId: string, online = true): Member => ({
  memberId,
  nickname: memberId,
  role: "member",
  online,
});

function snapshot(
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

function roomUpdated(mode: Mode, quality: Quality = "standard"): ServerMessage {
  return {
    type: "room:updated",
    room: { roomId: "room", locked: false, mode, quality, createdAt: 1 },
  };
}

function setup(
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

// ── 開播 ─────────────────────────────────────────────────

describe("開播", () => {
  test("start() resolve 之前不送 live:true；之後才送，ack 後是 live", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    expect(t.log).toEqual(["create p2p", "start"]);
    expect(t.session.getView().phase).toBe("starting");
    await flush();
    expect(t.client.requests).toHaveLength(0);

    const transport = t.transports[0]!;
    expect(transport.options).toMatchObject({
      mode: "p2p",
      quality: "standard",
      roomId: "room",
      token: "host-token",
    });
    transport.gate.resolve();
    await flush();
    expect(t.log).toEqual(["create p2p", "start", "stream:status live 電影"]);
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView()).toEqual({
      intent: true,
      phase: "live",
      error: null,
    });
  });

  test("還沒收到 snapshot 時不建立傳輸", () => {
    const t = setup();
    t.session.setSource(readySource());
    t.client.state({ status: "open" });
    expect(t.transports).toHaveLength(0);
    expect(t.session.getView().phase).toBe("waiting");
  });

  test("沒有開播意圖時不建立傳輸，按開始直播才建立", () => {
    const t = setup({ intent: false });
    t.connect();
    t.session.setSource(readySource());
    expect(t.transports).toHaveLength(0);
    expect(t.session.getView().phase).toBe("idle");
    t.session.setIntent(true);
    expect(t.onIntentChange).toHaveBeenCalledWith(true);
    expect(t.log).toEqual(["create p2p", "start"]);
  });

  test("start() 失敗：不送 live、拆掉傳輸、取消意圖並顯示錯誤；再按一次就重試", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.reject(
      new TransportError("SIGNAL_ERROR", "無法訂閱連線信令"),
    );
    await flush();
    expect(t.log).toEqual(["create p2p", "start", "destroy"]);
    expect(t.client.requests).toHaveLength(0);
    expect(t.onIntentChange).toHaveBeenLastCalledWith(false);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toContain("無法訂閱連線信令");

    t.session.setIntent(true);
    expect(t.session.getView().error).toBeNull();
    expect(t.transports).toHaveLength(2);
  });

  test("轉發模式在 T-109 前同步丟出 RELAY_UNAVAILABLE：顯示可讀錯誤、不當機", () => {
    // 用真正的 dispatcher（features/transport/index.ts）。
    const t = setup({ createTransport: createHostTransport });
    t.connect(snapshot({ mode: "relay" }));
    expect(() => t.session.setSource(readySource())).not.toThrow();
    expect(t.client.requests).toHaveLength(0);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toContain("轉發模式還沒完成");
  });

  test("live:true 被伺服器拒絕：拆掉傳輸、取消意圖、顯示錯誤", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.resolve();
    await flush();
    await t.client.ack("stream:status live 電影", new ApiError("FORBIDDEN"));
    expect(t.log.at(-1)).toBe("destroy");
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toBeTruthy();
  });

  test("live:true 因斷線失敗：保留意圖不顯示錯誤，下一次 snapshot 重建", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.transports[0]!.gate.resolve();
    await flush();
    await t.client.ack(
      "stream:status live 電影",
      new SignalDisconnectedError(),
    );
    expect(t.log.at(-1)).toBe("destroy");
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
      error: null,
    });
    t.connect();
    expect(t.transports).toHaveLength(2);
  });

  test("start() 期間按停止：start 完成後不送 live:true，直接拆掉", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.session.setIntent(false);
    t.transports[0]!.gate.resolve();
    await flush();
    expect(t.log).toEqual(["create p2p", "start", "destroy"]);
    expect(t.session.getView().phase).toBe("idle");
  });
});

// ── 換片與 track ─────────────────────────────────────────

describe("換片與 track 異動", () => {
  test("換片走 replaceTrack、不重建，檢查期間不停播，片名更新", async () => {
    const t = setup();
    await t.goLive();
    t.session.setSource({ stream: null, status: "checking", title: "新片" });
    expect(t.log).toEqual(["replace video null", "replace audio null"]);
    expect(t.session.getView().phase).toBe("live");

    const next = new FakeStream(
      fakeTrack("video", "v2"),
      fakeTrack("audio", "a2"),
    );
    t.session.setSource(readySource(next, "新片"));
    expect(t.log).toEqual([
      "replace video null",
      "replace audio null",
      "replace video v2",
      "replace audio a2",
      "stream:status live 新片",
    ]);
    expect(t.transports).toHaveLength(1);
    await t.client.ack("stream:status live 新片");
    // 同樣的片名不重送
    t.session.setSource(readySource(next, "新片"));
    expect(t.client.requests).toHaveLength(0);
  });

  test("同一個 stream 的 removetrack／addtrack：只對變的 kind 呼叫 replaceTrack", async () => {
    const t = setup();
    const video = fakeTrack("video", "v1");
    const stream = new FakeStream(video, fakeTrack("audio", "a1"));
    await t.goLive(readySource(stream));

    stream.remove(video); // 影片播完，Chrome 移除 track
    t.session.setSource(readySource(stream));
    expect(t.log).toEqual(["replace video null"]);

    stream.add(fakeTrack("video", "v1b")); // 重播加入新 track
    t.session.setSource(readySource(stream));
    t.session.setSource(readySource(stream));
    expect(t.log).toEqual(["replace video null", "replace video v1b"]);
    expect(t.transports).toHaveLength(1);
  });

  test("直播中片源失敗：送停播，確認後 stop／destroy，保留意圖；片源恢復再重建", async () => {
    const t = setup();
    await t.goLive();
    t.session.setSource({ stream: null, status: "error", title: "壞片" });
    expect(t.log).toEqual([
      "replace video null",
      "replace audio null",
      "stream:status off",
    ]);
    await t.client.ack("stream:status off");
    expect(t.log.slice(-2)).toEqual(["stop", "destroy"]);
    expect(t.session.getView()).toMatchObject({
      intent: true,
      phase: "waiting",
    });

    t.session.setSource(readySource(undefined, "好片"));
    expect(t.transports).toHaveLength(2);
  });
});

// ── 畫質、成員 ───────────────────────────────────────────

describe("畫質與成員", () => {
  test("畫質：送 room:update，收到 room:updated 後才 setQuality", async () => {
    const t = setup();
    const transport = await t.goLive();
    t.session.setQuality("smooth");
    expect(t.log).toEqual(["room:update quality=smooth"]);
    t.client.emit(roomUpdated("p2p", "smooth"));
    expect(t.log).toEqual(["room:update quality=smooth", "setQuality smooth"]);

    transport.setQualityResult.error = new TransportError(
      "TRACK_ERROR",
      "畫質套用失敗",
    );
    t.client.emit(roomUpdated("p2p", "high"));
    await flush();
    expect(t.session.getView().error).toBe("畫質套用失敗");
  });

  test("傳輸的 TRACK_ERROR 顯示給房主", async () => {
    const t = setup();
    const transport = await t.goLive();
    transport.emitError(
      new TransportError("TRACK_ERROR", "換軌失敗", { memberId: "v1" }),
    );
    expect(t.session.getView().error).toBe("換軌失敗");
  });

  test("removePeer：之前在線、現在離線或消失（被踢、離開）的收看者；在線者不呼叫", async () => {
    const t = setup();
    t.connect(
      snapshot({
        members: [host, viewer("v1"), viewer("v2"), viewer("v3", false)],
      }),
    );
    t.session.setSource(readySource());
    t.transports[0]!.gate.resolve();
    await flush();
    await t.client.ack("stream:status live 電影");
    t.log.length = 0;

    t.client.emit({
      type: "room:members",
      members: [
        host,
        viewer("v1"),
        viewer("v2", false),
        viewer("v3", false),
        viewer("v4"),
      ],
    });
    expect(t.log).toEqual(["removePeer v2"]);

    t.client.emit({ type: "room:members", members: [host, viewer("v4")] });
    expect(t.log).toEqual(["removePeer v2", "removePeer v1"]);
  });
});

// ── 停播 ─────────────────────────────────────────────────

describe("停播", () => {
  test("送 live:false，ack 之後才 stop／destroy", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    expect(t.log).toEqual(["stream:status off"]);
    expect(t.session.getView().phase).toBe("stopping");
    await t.client.ack("stream:status off");
    expect(t.log).toEqual(["stream:status off", "stop", "destroy"]);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
  });

  test("停播廣播先到也算確認", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    t.client.emit({
      type: "stream:status",
      live: false,
      title: null,
      startedAt: null,
    });
    await flush();
    expect(t.log).toEqual(["stream:status off", "stop", "destroy"]);
  });

  test("停播被拒：仍拆掉傳輸並顯示錯誤", async () => {
    const t = setup();
    await t.goLive();
    t.session.setIntent(false);
    await t.client.ack("stream:status off", new ApiError("INTERNAL"));
    expect(t.log).toEqual(["stream:status off", "destroy"]);
    expect(t.session.getView().error).toBeTruthy();
  });
});

// ── 切模式（§6「房主」1～4 步）─────────────────────────

describe("直播中切模式", () => {
  test("1 停播並等 ack → 2 stop、room:update、room:updated 後 destroy → 3 建新傳輸 start → 4 live:true", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    expect(t.session.getView().phase).toBe("switching");
    expect(t.log).toEqual(["stream:status off"]);

    await t.client.ack("stream:status off");
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "room:update mode=relay",
    ]);

    t.client.emit(roomUpdated("relay"));
    await flush();
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "room:update mode=relay",
      "destroy",
      "create relay",
      "start",
    ]);
    expect(t.session.getView().phase).toBe("starting");

    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.log.at(-1)).toBe("stream:status live 電影");
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");
    expect(t.transports[1]!.options.mode).toBe("relay");
  });

  test("第 1 步以本次之後的停播廣播確認，也能進第 2 步", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    t.client.emit({
      type: "stream:status",
      live: false,
      title: null,
      startedAt: null,
    });
    await flush();
    expect(t.log).toEqual([
      "stream:status off",
      "stop",
      "room:update mode=relay",
    ]);
  });

  test("第 1 步失敗或逾時：停在第 1 步，不送 room:update、不停舊傳輸", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    // SignalClient.request 逾時以 ApiError("INTERNAL") reject。
    await t.client.ack("stream:status off", new ApiError("INTERNAL"));
    expect(t.log).toEqual(["stream:status off"]);
    expect(t.session.getView().phase).toBe("live");
    expect(t.session.getView().error).toContain("切換失敗");
    expect(t.transports).toHaveLength(1);
  });

  test("切換中再按切換：忽略", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    t.session.setMode("relay");
    expect(t.log).toEqual(["stream:status off"]);
  });

  test("room:update 被拒：拆掉舊傳輸、顯示錯誤，用原模式重新開播", async () => {
    const t = setup();
    await t.goLive();
    t.session.setMode("relay");
    await t.client.ack("stream:status off");
    await t.client.ack("room:update mode=relay", new ApiError("FORBIDDEN"));
    expect(t.log.slice(3)).toEqual(["destroy", "create p2p", "start"]);
    expect(t.session.getView().error).toContain("切換傳送方式失敗");
  });

  test("沒在直播時切模式：只送 room:update", () => {
    const t = setup({ intent: false });
    t.connect();
    t.session.setMode("relay");
    expect(t.log).toEqual(["room:update mode=relay"]);
  });
});

// ── 重新連線與關閉 ───────────────────────────────────────

describe("房主重新連線", () => {
  test("斷線期間保留傳輸；新的 snapshot 銷毀舊傳輸並重建，start 後才送 live:true", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "reconnecting", attempt: 1 });
    expect(t.log).toEqual([]);
    expect(t.session.getView().phase).toBe("waiting");

    t.connect();
    expect(t.log).toEqual(["destroy", "create p2p", "start"]);
    await flush();
    expect(t.client.requests).toHaveLength(0);
    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.log.at(-1)).toBe("stream:status live 電影");
  });

  test("重新連線時片源還沒就緒（重新整理後）：不重建，片源就緒後才開播", () => {
    const t = setup({ intent: true });
    t.connect();
    t.session.setSource({ stream: null, status: "idle", title: "" });
    expect(t.transports).toHaveLength(0);
    expect(t.session.getView().phase).toBe("waiting");
    t.session.setSource(readySource());
    expect(t.transports).toHaveLength(1);
  });

  test("被 4000 取代：銷毀傳輸，之後不再送任何東西", async () => {
    const t = setup();
    await t.goLive();
    t.client.state({ status: "closed", reason: "replaced" });
    expect(t.log).toEqual(["destroy"]);
    t.session.setIntent(false);
    t.session.setSource(readySource(undefined, "別片"));
    t.client.emit(snapshot());
    expect(t.log).toEqual(["destroy"]);
  });

  test("舊代次的 start() 晚 resolve：不送 live:true", async () => {
    const t = setup();
    t.connect();
    t.session.setSource(readySource());
    t.connect(); // 重新驗證
    expect(t.log).toEqual([
      "create p2p",
      "start",
      "destroy",
      "create p2p",
      "start",
    ]);
    t.transports[0]!.gate.resolve();
    await flush();
    expect(t.client.requests).toHaveLength(0);
    t.transports[1]!.gate.resolve();
    await flush();
    expect(t.client.requests.map((r) => label(r.message))).toEqual([
      "stream:status live 電影",
    ]);
  });

  test("直播中傳輸整體失敗：拆掉、取消意圖、送停播並顯示錯誤", async () => {
    const t = setup();
    const transport = await t.goLive();
    transport.emitState("error");
    expect(t.log).toEqual(["destroy", "stream:status off"]);
    expect(t.session.getView()).toMatchObject({ intent: false, phase: "idle" });
    expect(t.session.getView().error).toBeTruthy();
  });

  test("不是房主的 snapshot：什麼都不做", () => {
    const t = setup();
    t.client.state({ status: "open" });
    t.client.emit({
      ...snapshot(),
      you: { memberId: "v1", role: "member" },
    } as ServerMessage);
    t.session.setSource(readySource());
    expect(t.log).toEqual([]);
  });

  test("getView 沒變時回傳同一個物件", async () => {
    const t = setup();
    await t.goLive();
    const before = t.session.getView();
    t.client.emit({ type: "room:members", members: [host, viewer("v1")] });
    expect(t.session.getView()).toBe(before);
  });
});

// ── 整合：真的 P2P host transport + rtc-fake ─────────────

describe("整合：P2P host transport", () => {
  useRtcFakes();

  test("live:true 之後收到 peer:request，offer 經 client.send 送出；收看者離線時關閉連線", async () => {
    const { factory, connections } = createFakePeerConnectionFactory();
    const createTransport: CreateHostTransport = (options) =>
      createHostTransport({
        ...options,
        createPeerConnection: factory,
        fetchIceServers: async () => [],
        getCodecCapabilities: (kind) =>
          kind === "video"
            ? [{ mimeType: "video/H264", clockRate: 90000 }]
            : [{ mimeType: "audio/opus", clockRate: 48000 }],
      });
    const t = setup({ createTransport });
    t.connect();
    const stream = new MediaStream([
      rtcTrack("video", 1080),
      rtcTrack("audio"),
    ]);
    t.session.setSource({ stream, status: "ready", title: "電影" });
    await flushTimers();
    await t.client.ack("stream:status live 電影");
    expect(t.session.getView().phase).toBe("live");

    t.client.emit({ type: "peer:request", memberId: "v1" });
    await flushTimers();
    const offer = t.client.sent.find(
      (m) => m.to === "v1" && m.data.type === "offer",
    );
    expect(offer).toBeTruthy();
    expect(connections).toHaveLength(1);

    t.client.emit({
      type: "room:members",
      members: [host, viewer("v1", false)],
    });
    expect(connections[0]!.closed).toBe(true);
  });
});
