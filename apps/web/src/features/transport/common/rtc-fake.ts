/**
 * 測試用 fake RTCPeerConnection（testing.md：WebRTC 邏輯要用 fake，不依賴真實瀏覽器）。
 *
 * 盡量貼近真實 Chrome 的行為：
 * - `createOffer`／`createAnswer` 只回傳描述，不改變 signalingState；
 *   signalingState 在 `set*Description` 時才轉換。
 * - `addIceCandidate` 在 remote description 還沒設定前會 throw；`null` 記為
 *   end-of-candidates。
 * - 遠端 offer 的影音 m-line 會建立接收 transceiver，再用 `fireTrack` 送入測試 track。
 * - `fireIceCandidate` 模擬本機收集，candidate 會寫進測試 SDP，null 表示收集完成。
 * - `getStats()` 回傳 Map 形狀（測試可覆寫 `statsReport`）。
 *
 * 測試用 `createFakePeerConnectionFactory()` 拿到 factory 與建立的連線清單，
 * 再把 factory 傳進 `createHostTransport`／`createViewerTransport` 的
 * `createPeerConnection` 選項。
 */
import { waitForIceGathering } from "./ice-gathering";
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

export class FakeRtcPeerConnection
  extends EventTarget
  implements RtcPeerConnection
{
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";

  onicecandidate: ((event: RtcIceCandidateEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  ontrack: ((event: RtcTrackEvent) => void) | null = null;

  private local: RtcSessionDescription | null = null;
  private readonly lifetime = new AbortController();
  remoteDescription: RtcSessionDescription | null = null;
  iceCandidates: RtcIceCandidate[] = [];
  endOfCandidates = false;
  offerOptions: RTCOfferOptions[] = [];

  /** 測試可覆寫 `getStats()` 的回傳內容（Map 形狀）。 */
  statsReport: unknown = new Map();

  private transceivers: FakeRtcRtpTransceiver[] = [];

  constructor(readonly configuration: RTCConfiguration) {
    super();
  }

  get closed(): boolean {
    return this.lifetime.signal.aborted;
  }

  get localDescription(): RtcSessionDescription | null {
    return this.local ? { ...this.local } : null;
  }

  addTransceiver(
    trackOrKind: MediaStreamTrack | "audio" | "video",
    init?: RTCRtpTransceiverInit,
  ): FakeRtcRtpTransceiver {
    this.lifetime.signal.throwIfAborted();
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
    this.lifetime.signal.throwIfAborted();
    this.offerOptions.push(options ?? {});
    return this.makeDescription("offer");
  }

  async createAnswer(): Promise<RtcSessionDescription> {
    this.lifetime.signal.throwIfAborted();
    if (this.signalingState !== "have-remote-offer") {
      throw new DOMException("尚未收到遠端 offer", "InvalidStateError");
    }
    return this.makeDescription("answer");
  }

  async setLocalDescription(
    description?: RtcSessionDescription,
  ): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const type =
      this.signalingState === "have-remote-offer" ? "answer" : "offer";
    if (description && description.type !== type) {
      throw new DOMException("本機 SDP 與協商狀態不符", "InvalidStateError");
    }
    this.local = description ? { ...description } : this.makeDescription(type);
    this.setSignalingState(type === "offer" ? "have-local-offer" : "stable");
    if (/^m=/m.test(this.local.sdp)) this.setIceGatheringState("gathering");
  }

  waitForIceGatheringComplete(timeoutMs: number): Promise<void> {
    return waitForIceGathering(this, this.lifetime.signal, timeoutMs);
  }

  async setRemoteDescription(
    description: RtcSessionDescription,
  ): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    if (description.type === "offer") {
      // 每個影音 m-line 只配對一條 transceiver；再次協商沿用已存在的。
      const available = this.getTransceivers();
      for (const [, kind] of description.sdp.matchAll(/^m=(\S+) /gm)) {
        if (kind !== "audio" && kind !== "video") continue;
        const index = available.findIndex((t) => t.kind === kind);
        if (index >= 0) available.splice(index, 1);
        else this.addTransceiver(kind, { direction: "recvonly" });
      }
    } else if (this.signalingState !== "have-local-offer") {
      throw new DOMException("尚未設定本機 offer", "InvalidStateError");
    }
    this.remoteDescription = { ...description };
    this.setSignalingState(
      description.type === "offer" ? "have-remote-offer" : "stable",
    );
  }

  async addIceCandidate(candidate: RtcIceCandidate | null): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    if (!this.remoteDescription) {
      throw new DOMException(
        "remote description 尚未設定，不能 addIceCandidate",
        "InvalidStateError",
      );
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
    // Chrome 主動 close() 時會更新狀態，但不派發 signalingstatechange。
    this.signalingState = "closed";
    this.iceConnectionState = "closed";
    this.connectionState = "closed";
    this.lifetime.abort(new DOMException("連線已關閉", "InvalidStateError"));
  }

  private makeDescription(
    type: RtcSessionDescription["type"],
  ): RtcSessionDescription {
    const lines = ["v=0"];
    for (const [index, { kind, init }] of this.transceivers.entries()) {
      lines.push(
        `m=${kind} 9 UDP/TLS/RTP/SAVPF ${kind === "video" ? 96 : 111}`,
        `a=mid:${index}`,
        `a=${init?.direction ?? "sendrecv"}`,
      );
    }
    return { type, sdp: lines.join("\r\n") + "\r\n" };
  }

  private setSignalingState(state: RTCSignalingState): void {
    if (this.signalingState === state) return;
    this.signalingState = state;
    this.onsignalingstatechange?.();
  }

  // ── 測試控制用 ─────────────────────────────────────────

  fireIceCandidate(candidate: RtcIceCandidate | null): void {
    if (this.closed) return;
    if (candidate && this.local) {
      const sections = this.local.sdp.trimEnd().split(/\r?\n(?=m=)/);
      const index =
        candidate.sdpMid != null
          ? sections.findIndex((section) =>
              section.split(/\r?\n/).includes(`a=mid:${candidate.sdpMid}`),
            )
          : 1 + (candidate.sdpMLineIndex ?? 0);
      if (index > 0 && index < sections.length) {
        sections[index] += `\r\na=${candidate.candidate}`;
        this.local.sdp = sections.join("\r\n") + "\r\n";
      }
    }
    if (candidate === null) this.setIceGatheringState("complete");
    this.onicecandidate?.({ candidate });
  }

  setIceGatheringState(state: RTCIceGatheringState): void {
    if (this.closed || this.iceGatheringState === state) return;
    this.iceGatheringState = state;
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }

  /** 模擬遠端 track 到達；`streams` 預設為空（貼近 Chrome 的 sendonly 行為）。 */
  fireTrack(track: MediaStreamTrack, streams: MediaStream[] = []): void {
    if (this.closed) return;
    const transceiver = this.transceivers.find((t) => t.kind === track.kind);
    if (!transceiver) return;
    transceiver.receiver.track = track;
    this.ontrack?.({ track, streams, transceiver });
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    if (this.closed) return;
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  setIceConnectionState(state: RTCIceConnectionState): void {
    if (this.closed) return;
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
