/**
 * 測試用 fake RTCPeerConnection（testing.md：WebRTC 邏輯要用 fake，不依賴真實瀏覽器）。
 *
 * 盡量貼近真實 Chrome 的行為：
 * - `createOffer`／`createAnswer` 只回傳描述，不改變 signalingState；
 *   signalingState 在 `set*Description` 時才轉換。
 * - 影音共用 session 層的 ICE 憑證，restart 時雙方各自換發。
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

interface IceCredentials {
  ufrag: string;
  pwd: string;
}

let iceGeneration = 0;

function newIceCredentials(): IceCredentials {
  const id = ++iceGeneration;
  return { ufrag: `fake${id}`, pwd: `fakeIcePasswordForTests${id}` };
}

function iceUfrag(sdp?: string): string | undefined {
  return sdp?.match(/^a=ice-ufrag:(\S+)/m)?.[1];
}

function readIceCredentials(sdp?: string): IceCredentials | undefined {
  const ufrag = iceUfrag(sdp);
  const pwd = sdp?.match(/^a=ice-pwd:(\S+)/m)?.[1];
  if (ufrag && pwd) return { ufrag, pwd };
}

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

  constructor(
    track: MediaStreamTrack | null,
    private readonly lifetime?: AbortSignal,
  ) {
    this.track = track;
  }

  getParameters(): RTCRtpSendParameters {
    if (this.lifetime?.aborted) {
      return {
        codecs: [],
        encodings: [],
        headerExtensions: [],
        rtcp: { cname: "", reducedSize: false },
        transactionId: crypto.randomUUID(),
      };
    }
    return structuredClone(this.parameters);
  }

  async setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    this.lastParameters = structuredClone(parameters);
    this.lifetime?.throwIfAborted();
    this.parameters = structuredClone(parameters);
  }

  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.replaceTrackCalls.push(track);
    this.lifetime?.throwIfAborted();
    this.track = track;
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
    lifetime?: AbortSignal,
  ) {
    this.sender = new FakeRtcRtpSender(track, lifetime);
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
  private lastCreated?: RtcSessionDescription;
  private negotiatedRemoteIce?: IceCredentials;
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
    const transceiver = new FakeRtcRtpTransceiver(
      kind,
      track,
      init,
      this.lifetime.signal,
    );
    this.transceivers.push(transceiver);
    this.lastCreated = undefined;
    return transceiver;
  }

  getTransceivers(): FakeRtcRtpTransceiver[] {
    return [...this.transceivers];
  }

  async createOffer(options?: RTCOfferOptions): Promise<RtcSessionDescription> {
    this.lifetime.signal.throwIfAborted();
    this.offerOptions.push(options ?? {});
    return this.makeDescription("offer", options?.iceRestart);
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
    const draft =
      this.lastCreated?.type === type ? this.lastCreated : undefined;
    this.local = { ...(description ?? draft ?? this.makeDescription(type)) };
    this.lastCreated = undefined;
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
    this.lastCreated = undefined;
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
    iceRestart = false,
  ): RtcSessionDescription {
    const previous = this.negotiatedRemoteIce;
    const offered = readIceCredentials(this.remoteDescription?.sdp);
    const remoteRestart =
      type === "answer" &&
      previous &&
      offered &&
      (previous.ufrag !== offered.ufrag || previous.pwd !== offered.pwd);
    // 一般協商沿用已套用的本機憑證，即使剛產生過另一份 restart 草稿。
    const retained =
      iceRestart || remoteRestart
        ? undefined
        : readIceCredentials(this.local?.sdp);
    const { ufrag, pwd } = retained ?? newIceCredentials();
    const lines = ["v=0", `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`];
    for (const [index, { kind, init }] of this.transceivers.entries()) {
      lines.push(
        `m=${kind} 9 UDP/TLS/RTP/SAVPF ${kind === "video" ? 96 : 111}`,
        `a=mid:${index}`,
        `a=${init?.direction ?? "sendrecv"}`,
      );
    }
    this.lastCreated = { type, sdp: lines.join("\r\n") + "\r\n" };
    return { ...this.lastCreated };
  }

  private setSignalingState(state: RTCSignalingState): void {
    if (this.signalingState === state) return;
    if (state === "stable") {
      this.negotiatedRemoteIce = readIceCredentials(
        this.remoteDescription?.sdp,
      );
    }
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
      // 延遲的事件仍可送到 handler，SDP 只收這個 m-line 目前的 candidate。
      const ufrag = iceUfrag(sections[index]) ?? iceUfrag(sections[0]);
      if (
        index > 0 &&
        index < sections.length &&
        (candidate.usernameFragment == null ||
          candidate.usernameFragment === ufrag)
      ) {
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
