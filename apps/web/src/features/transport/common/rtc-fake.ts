/**
 * 測試用 fake RTCPeerConnection（testing.md：WebRTC 邏輯要用 fake，不依賴真實瀏覽器）。
 *
 * 盡量貼近真實 Chrome 的行為：
 * - `createOffer`／`createAnswer` 只回傳描述，不改變 signalingState；
 *   signalingState 在 `set*Description` 時才轉換。
 * - `addIceCandidate` 在 remote description 還沒設定前會 throw；`null` 記為
 *   end-of-candidates。
 * - `fireTrack` 模擬遠端建立的接收 track（供收看者的 recvonly transceiver）。
 * - `getStats()` 回傳 Map 形狀（測試可覆寫 `statsReport`）。
 *
 * 測試用 `createFakePeerConnectionFactory()` 拿到 factory 與建立的連線清單，
 * 再把 factory 傳進 `createHostTransport`／`createViewerTransport` 的
 * `createPeerConnection` 選項。
 */
import type {
  PeerConnectionFactory,
  RtcIceCandidate,
  RtcIceCandidateEvent,
  RtcPeerConnection,
  RtcRtpSender,
  RtcRtpTransceiver,
  RtcSessionDescription,
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

  localDescription: RtcSessionDescription | null = null;
  remoteDescription: RtcSessionDescription | null = null;
  iceCandidates: RtcIceCandidate[] = [];
  endOfCandidates = false;
  offerOptions: RTCOfferOptions[] = [];
  closed = false;

  /** 測試可覆寫 `getStats()` 的回傳內容（Map 形狀）。 */
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

  async createOffer(options?: RTCOfferOptions): Promise<RtcSessionDescription> {
    this.offerOptions.push(options ?? {});
    return { type: "offer", sdp: "v=0\r\nfake-offer\r\n" };
  }

  async createAnswer(): Promise<RtcSessionDescription> {
    return { type: "answer", sdp: "v=0\r\nfake-answer\r\n" };
  }

  async setLocalDescription(
    description?: RtcSessionDescription,
  ): Promise<void> {
    if (description) {
      this.localDescription = description;
      this.signalingState =
        description.type === "offer" ? "have-local-offer" : "stable";
    } else {
      this.signalingState = "stable";
    }
  }

  async setRemoteDescription(
    description: RtcSessionDescription,
  ): Promise<void> {
    this.remoteDescription = description;
    this.signalingState =
      description.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate(candidate: RtcIceCandidate | null): Promise<void> {
    if (!this.remoteDescription) {
      throw new Error("remote description 尚未設定，不能 addIceCandidate");
    }
    if (candidate === null) {
      this.endOfCandidates = true;
    } else {
      this.iceCandidates.push(candidate);
    }
  }

  async getStats(): Promise<RTCStatsReport> {
    return this.statsReport as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  // ── 測試控制用 ─────────────────────────────────────────

  fireIceCandidate(candidate: RtcIceCandidate | null): void {
    this.onicecandidate?.({ candidate });
  }

  /** 模擬遠端 track 到達；`streams` 預設為空（貼近 Chrome 的 sendonly 行為）。 */
  fireTrack(track: MediaStreamTrack, streams: MediaStream[] = []): void {
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
