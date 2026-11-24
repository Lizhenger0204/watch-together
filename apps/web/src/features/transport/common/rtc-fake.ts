/**
 * 測試用 fake RTCPeerConnection（testing.md：WebRTC 邏輯要用 fake，不依賴真實瀏覽器）。
 *
 * 它不做真實協商，只記錄呼叫並提供控制方法讓測試驅動事件：
 * - 建立 offer/answer 回傳固定 SDP。
 * - `fireIceCandidate`／`fireTrack`／`setConnectionState` 等手動觸發事件。
 * - `statsReport` 可被測試覆寫，`getStats()` 直接回傳。
 *
 * 測試裡用 `createFakePeerConnectionFactory()` 拿到 factory 與建立的連線清單，
 * 再把 factory 傳進 `createHostTransport`／`createViewerTransport` 的
 * `createPeerConnection` 選項。
 */
import type {
  PeerConnectionFactory,
  RtcIceCandidateEvent,
  RtcPeerConnection,
  RtcRtpSender,
  RtcRtpTransceiver,
  RtcTrackEvent,
} from "./rtc";

/** fake 用的 receiver：`track` 可變，方便 `fireTrack` 塞入。 */
export interface FakeRtcRtpReceiver {
  track: MediaStreamTrack | null;
}

export class FakeRtcRtpSender implements RtcRtpSender {
  track: MediaStreamTrack | null;
  /** setParameters 最後一次收到的參數。 */
  lastParameters: RTCRtpSendParameters | undefined;
  /** replaceTrack 的所有呼叫記錄。 */
  replaceTrackCalls: (MediaStreamTrack | null)[] = [];

  private parameters: RTCRtpSendParameters = {
    codecs: [],
    encodings: [{}],
    headerExtensions: [],
    rtcp: {},
    transactionId: "fake",
  };

  constructor(track: MediaStreamTrack | null) {
    this.track = track;
  }

  getParameters(): RTCRtpSendParameters {
    return structuredClone(this.parameters);
  }

  setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    this.parameters = structuredClone(parameters);
    this.lastParameters = structuredClone(parameters);
    return Promise.resolve();
  }

  replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.replaceTrackCalls.push(track);
    this.track = track;
    return Promise.resolve();
  }
}

export class FakeRtcRtpTransceiver implements RtcRtpTransceiver {
  readonly sender: FakeRtcRtpSender;
  readonly receiver: FakeRtcRtpReceiver;
  codecPreferences: RTCRtpCodec[] = [];

  constructor(
    readonly kind: "audio" | "video",
    track: MediaStreamTrack | null,
    readonly init?: RTCRtpTransceiverInit,
  ) {
    this.sender = new FakeRtcRtpSender(track);
    this.receiver = { track: null };
  }

  setCodecPreferences(codecs: RTCRtpCodec[]): void {
    this.codecPreferences = [...codecs];
  }
}

export class FakeRtcPeerConnection implements RtcPeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";

  onicecandidate: ((event: RtcIceCandidateEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  ontrack: ((event: RtcTrackEvent) => void) | null = null;

  localDescription: RTCLocalSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceCandidates: RTCIceCandidateInit[] = [];
  offerOptions: RTCOfferOptions[] = [];
  closed = false;

  /** 測試可覆寫 `getStats()` 的回傳內容。 */
  statsReport: unknown = new Map();

  private transceivers: FakeRtcRtpTransceiver[] = [];

  constructor(readonly configuration: RTCConfiguration) {}

  addTransceiver(
    trackOrKind: MediaStreamTrack | "audio" | "video",
    init?: RTCRtpTransceiverInit,
  ): FakeRtcRtpTransceiver {
    // MediaStreamTrack.kind 在 DOM 型別是 string，這裡收窄成 "audio" | "video"。
    const kind: "audio" | "video" =
      typeof trackOrKind === "string"
        ? trackOrKind
        : trackOrKind.kind === "audio"
          ? "audio"
          : "video";
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const transceiver = new FakeRtcRtpTransceiver(kind, track, init);
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers(): FakeRtcRtpTransceiver[] {
    return [...this.transceivers];
  }

  async createOffer(
    options?: RTCOfferOptions,
  ): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options ?? {});
    this.signalingState = "have-local-offer";
    return { type: "offer", sdp: "v=0\r\nfake-offer\r\n" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.signalingState = "have-local-pranswer";
    return { type: "answer", sdp: "v=0\r\nfake-answer\r\n" };
  }

  async setLocalDescription(
    description?: RTCLocalSessionDescriptionInit,
  ): Promise<void> {
    if (description) this.localDescription = description;
    this.signalingState = "stable";
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = "have-remote-offer";
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    if (candidate) this.iceCandidates.push(candidate);
  }

  async getStats(): Promise<RTCStatsReport> {
    return this.statsReport as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  // ── 測試控制用 ─────────────────────────────────────────

  fireIceCandidate(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({ candidate });
  }

  fireTrack(track: MediaStreamTrack, streams: MediaStream[]): void {
    const transceiver =
      this.transceivers.find((t) => t.kind === track.kind) ??
      this.transceivers[0];
    if (!transceiver) return;
    transceiver.receiver.track = track;
    this.ontrack?.({ track, streams, transceiver });
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  setIceConnectionState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

export interface FakePeerConnectionFactoryResult {
  factory: PeerConnectionFactory;
  /** factory 建立過的所有 fake 連線（依建立順序）。 */
  connections: FakeRtcPeerConnection[];
}

export function createFakePeerConnectionFactory(): FakePeerConnectionFactoryResult {
  const connections: FakeRtcPeerConnection[] = [];
  return {
    factory: (configuration) => {
      const pc = new FakeRtcPeerConnection(configuration);
      connections.push(pc);
      return pc;
    },
    connections,
  };
}
