import type { SignalData } from "@project/shared";
import { TARGETS } from "../common/encoding.fixtures";
import { afterEach, beforeEach, vi } from "vitest";
import type {
  HostTransportOptions,
  TransportSignal,
  ViewerTransportOptions,
} from "../index";
import { Emitter } from "../common";
import { createFakePeerConnectionFactory } from "../common/rtc-fake";
import { TestStream, track } from "../common/test-media";

export { track };
import { createP2PHostTransport, createP2PViewerTransport } from "./index";

export function useRtcFakes() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaStream", TestStream);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

export class TestSignal implements TransportSignal {
  private events = new Emitter<{
    message: [{ from: string; data: SignalData }];
    request: [{ memberId: string }];
  }>();
  sendSignal = vi.fn<TransportSignal["sendSignal"]>(() => true);
  onSignal: TransportSignal["onSignal"] = (handler) =>
    this.events.on("message", handler);
  onPeerRequest: TransportSignal["onPeerRequest"] = (handler) =>
    this.events.on("request", handler);
  deliver(from: string, data: SignalData) {
    this.events.emit("message", { from, data });
  }
  request(memberId = "viewer") {
    this.events.emit("request", { memberId });
  }
  description(
    type: "offer" | "answer",
    to = type === "offer" ? "viewer" : "host",
  ) {
    for (const [target, data] of [...this.sendSignal.mock.calls].reverse()) {
      if (target === to && data.type === type) return data;
    }
    throw new Error(`Missing ${type} for ${to}`);
  }
}

function endpoint() {
  const signal = new TestSignal();
  const { factory, connections } = createFakePeerConnectionFactory();
  const fetchIceServers = vi.fn<
    NonNullable<ViewerTransportOptions["fetchIceServers"]>
  >(async () => []);
  const options: ViewerTransportOptions = {
    signal,
    mode: "p2p",
    roomId: "room",
    token: "",
    createPeerConnection: factory,
    fetchIceServers,
    getCodecCapabilities: (kind) =>
      kind === "video"
        ? [
            { mimeType: "video/VP8", clockRate: 90000 },
            { mimeType: "video/H264", clockRate: 90000 },
          ]
        : [
            { mimeType: "audio/PCMU", clockRate: 8000 },
            { mimeType: "audio/opus", clockRate: 48000 },
          ],
  };
  return { signal, connections, fetchIceServers, options };
}

export function makeHost(
  stream = new MediaStream([track("video", 2160)]),
  overrides?: Partial<HostTransportOptions>,
) {
  const endpointData = endpoint();
  const host = createP2PHostTransport({
    ...endpointData.options,
    stream,
    quality: TARGETS.standard,
    ...overrides,
  });
  return { ...endpointData, host };
}

export function makeViewer(overrides?: Partial<ViewerTransportOptions>) {
  const endpointData = endpoint();
  const viewer = createP2PViewerTransport({
    ...endpointData.options,
    ...overrides,
  });
  return { ...endpointData, viewer };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export const flush = () => vi.advanceTimersByTimeAsync(0);

export function sdp(sessionId = "100", fragment = "remote") {
  return [
    "v=0",
    `o=- ${sessionId} 1 IN IP4 127.0.0.1`,
    `a=ice-ufrag:${fragment}`,
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=mid:vid",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=mid:sound",
    "a=ice-ufrag:audio",
    "",
  ].join("\r\n");
}

export function answerHost(signal: TestSignal, memberId = "viewer") {
  const { negotiationId } = signal.description("offer", memberId);
  signal.deliver(memberId, { type: "answer", negotiationId, sdp: sdp() });
}
