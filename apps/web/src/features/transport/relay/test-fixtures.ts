import { afterEach, beforeEach, vi } from "vitest";
import type {
  HostTransportOptions,
  TransportSignal,
  ViewerTransportOptions,
} from "../index";
import { createFakePeerConnectionFactory } from "../common/rtc-fake";
import { createRelayHostTransport, createRelayViewerTransport } from "./index";
import { resetPublishQueues } from "./publish-queue";

export const ROOM = "0b6f6e2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
export const TOKEN = "secret-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const location = (id = "11111111-2222-3333-4444-555555555555") =>
  `/api/rooms/${ROOM}/relay/${id}`;

class TestStream {
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  addTrack(track: MediaStreamTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((current) => current !== track);
  }
}

export function track(kind: "audio" | "video", height?: number) {
  return {
    id: crypto.randomUUID(),
    kind,
    contentHint: "",
    readyState: "live",
    getSettings: () => ({ height }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

/** 一則還沒回應的 HTTP 請求。 */
export interface PendingRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  keepalive: boolean | undefined;
  respond(
    status: number,
    body?: string,
    headers?: Record<string, string>,
  ): void;
  fail(error?: unknown): void;
}

/** 可控的假 fetch：每個請求都停在途中，直到測試呼叫 respond／fail。 */
export class FakeHttp {
  readonly requests: PendingRequest[] = [];
  readonly fetch = vi.fn((url: string, init: RequestInit = {}) => {
    return new Promise<Response>((resolve, reject) => {
      this.requests.push({
        url,
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === "string" ? init.body : undefined,
        keepalive: init.keepalive,
        respond: (status, body, headers) =>
          resolve(
            new Response(status === 204 ? null : (body ?? ""), {
              status,
              headers,
            }),
          ),
        fail: (error = new TypeError("Failed to fetch")) => reject(error),
      });
    });
  });

  posts() {
    return this.requests.filter((r) => r.method === "POST");
  }
  deletes() {
    return this.requests.filter((r) => r.method === "DELETE");
  }
  lastPost() {
    const post = this.posts().at(-1);
    if (!post) throw new Error("沒有 POST");
    return post;
  }
}

export const answerSdp = "v=0\r\na=ice-ufrag:sfu\r\na=ice-pwd:sfupassword\r\n";

export function created(request: PendingRequest, id?: string) {
  request.respond(201, answerSdp, {
    "Content-Type": "application/sdp",
    Location: location(id),
  });
}

export function useRelayFakes() {
  let http!: FakeHttp;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaStream", TestStream);
    http = new FakeHttp();
    vi.stubGlobal("fetch", http.fetch);
    resetPublishQueues();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return () => http;
}

const noSignal: TransportSignal = {
  sendSignal: () => false,
  onSignal: () => () => {},
  onPeerRequest: () => () => {},
};

function endpoint() {
  const { factory, connections } = createFakePeerConnectionFactory();
  const fetchIceServers = vi.fn<
    NonNullable<ViewerTransportOptions["fetchIceServers"]>
  >(async () => []);
  return {
    connections,
    fetchIceServers,
    options: {
      signal: noSignal,
      mode: "relay" as const,
      roomId: ROOM,
      token: TOKEN,
      createPeerConnection: factory,
      fetchIceServers,
      getCodecCapabilities: (kind: "audio" | "video") =>
        kind === "video"
          ? [
              { mimeType: "video/VP8", clockRate: 90000 },
              { mimeType: "video/H264", clockRate: 90000 },
            ]
          : [{ mimeType: "audio/opus", clockRate: 48000 }],
    },
  };
}

export function makeHost(
  stream = new MediaStream([track("video", 2160), track("audio")]),
  overrides?: Partial<HostTransportOptions>,
) {
  const data = endpoint();
  const host = createRelayHostTransport({
    ...data.options,
    stream,
    quality: "standard",
    ...overrides,
  });
  return { ...data, host };
}

export function makeViewer(overrides?: Partial<ViewerTransportOptions>) {
  const data = endpoint();
  const viewer = createRelayViewerTransport({ ...data.options, ...overrides });
  return { ...data, viewer };
}

export const flush = () => vi.advanceTimersByTimeAsync(0);

/** 讓最新的連線完成 ICE 收集（一個 candidate 加結束標記）。 */
export async function gather(
  connections: { fireIceCandidate(c: unknown): void }[],
) {
  await flush();
  const pc = connections.at(-1);
  if (!pc) throw new Error("沒有連線");
  pc.fireIceCandidate({
    candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: null,
  });
  pc.fireIceCandidate(null);
  await flush();
}

/** 收集 promise 的結果，不讓未處理的 rejection 中斷測試。 */
export function settle<T>(promise: Promise<T>) {
  const result: { value?: T; error?: unknown; done: boolean } = {
    done: false,
    value: undefined,
    error: undefined,
  };
  promise.then(
    (value) => {
      result.value = value;
      result.done = true;
    },
    (error: unknown) => {
      result.error = error;
      result.done = true;
    },
  );
  return result;
}
