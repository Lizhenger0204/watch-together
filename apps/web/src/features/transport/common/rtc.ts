/**
 * RTCPeerConnection 的最小介面與瀏覽器 adapter。
 *
 * 傳輸層只透過這些介面碰 WebRTC，單元測試用 `rtc-fake.ts` 的 fake 實作，
 * 不依賴真實瀏覽器（testing.md）。
 *
 * `browserPeerConnectionFactory` 不是把原生物件硬 cast 成介面，而是包一層
 * adapter，原因是：
 * - `addTransceiver`／`getTransceivers` 時記下 `kind`（原生 transceiver 在部分
 *   瀏覽器上的 kind 不穩定，且收到遠端 track 前 sender.track 可能為 null）。
 * - 把 `RTCIceCandidate` 正規化成 `{ candidate: string, ... }`（candidate 非空）。
 * - 保證 offer/answer 的 `sdp` 是非空 string（否則丟 `SIGNAL_ERROR`）。
 *
 * 這樣 p2p/、relay/ 拿到的值都能直接送進 `SignalData`（shared 要求 string）。
 */
import { TransportError } from "./errors";
import { waitForIceGathering } from "./ice-gathering";

/** RTCRtpSender 最小介面。 */
export interface RtcRtpSender {
  readonly track: MediaStreamTrack | null;
  getParameters(): RTCRtpSendParameters;
  setParameters(parameters: RTCRtpSendParameters): Promise<void>;
  replaceTrack(track: MediaStreamTrack | null): Promise<void>;
}

/** RTCRtpReceiver 最小介面。sendonly 的 transceiver 可能還沒有 remote track。 */
export interface RtcRtpReceiver {
  readonly track: MediaStreamTrack | null;
}

/** RTCRtpTransceiver 最小介面。 */
export interface RtcRtpTransceiver {
  readonly kind: "audio" | "video";
  readonly sender: RtcRtpSender;
  readonly receiver: RtcRtpReceiver;
  setCodecPreferences(codecs: RTCRtpCodec[]): void;
}

/** 正規化後的 ICE candidate；`candidate` 一定是非空字串。 */
export interface RtcIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** onicecandidate 事件：`candidate === null` 代表 end-of-candidates。 */
export interface RtcIceCandidateEvent {
  candidate: RtcIceCandidate | null;
}

/** 正規化後的 session description；`sdp` 一定是非空字串。 */
export interface RtcSessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** ontrack 事件：收看端由此把 track 加入固定的 remoteStream。 */
export interface RtcTrackEvent {
  track: MediaStreamTrack;
  /** 別依賴這個欄位拿 remoteStream；Chrome 上 sendonly transceiver 的 streams 可能是空的。 */
  streams: readonly MediaStream[];
  transceiver: RtcRtpTransceiver;
}

/** RTCPeerConnection 最小介面。 */
export interface RtcPeerConnection {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly signalingState: RTCSignalingState;
  /** 含目前已收集的本機 ICE candidates，供 WHIP／WHEP 組成單次 HTTP offer。 */
  readonly localDescription: RtcSessionDescription | null;

  addTransceiver(
    trackOrKind: MediaStreamTrack | "audio" | "video",
    init?: RTCRtpTransceiverInit,
  ): RtcRtpTransceiver;
  getTransceivers(): RtcRtpTransceiver[];
  createOffer(options?: RTCOfferOptions): Promise<RtcSessionDescription>;
  createAnswer(options?: RTCAnswerOptions): Promise<RtcSessionDescription>;
  setLocalDescription(description?: RtcSessionDescription): Promise<void>;
  /** 收集完成或逾時時 resolve；連線已關閉或等待中被關閉時 reject InvalidStateError。 */
  waitForIceGatheringComplete(timeoutMs: number): Promise<void>;
  setRemoteDescription(description: RtcSessionDescription): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidate | null): Promise<void>;
  getStats(): Promise<RTCStatsReport>;
  close(): void;

  onicecandidate: ((event: RtcIceCandidateEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onsignalingstatechange: (() => void) | null;
  ontrack: ((event: RtcTrackEvent) => void) | null;
}

/** 建立 RTCPeerConnection 的工廠；測試注入 fake。 */
export type PeerConnectionFactory = (
  configuration: RTCConfiguration,
) => RtcPeerConnection;

/** ICE 已連通（`connected` 或 `completed`）。 */
export function isIceConnected(pc: RtcPeerConnection) {
  return (
    pc.iceConnectionState === "connected" ||
    pc.iceConnectionState === "completed"
  );
}

// ── 瀏覽器 adapter ──────────────────────────────────────

function toKind(track: MediaStreamTrack | null): "audio" | "video" {
  return track?.kind === "audio" ? "audio" : "video";
}

function toIceCandidate(
  candidate: RTCIceCandidateInit | null,
): RtcIceCandidate | null {
  if (!candidate) return null;
  const { candidate: sdp, sdpMid, sdpMLineIndex, usernameFragment } = candidate;
  if (typeof sdp !== "string" || sdp === "") return null;
  return {
    candidate: sdp,
    sdpMid: sdpMid ?? null,
    sdpMLineIndex: sdpMLineIndex ?? null,
    usernameFragment: usernameFragment ?? null,
  };
}

function toSessionDescription(
  description: RTCSessionDescriptionInit,
): RtcSessionDescription {
  if (description.type !== "offer" && description.type !== "answer") {
    throw new TransportError(
      "SIGNAL_ERROR",
      `不支援的 SDP type：${description.type}`,
    );
  }
  if (typeof description.sdp !== "string" || description.sdp === "") {
    throw new TransportError("SIGNAL_ERROR", "SDP 缺少內容");
  }
  return { type: description.type, sdp: description.sdp };
}

class BrowserRtcRtpSender implements RtcRtpSender {
  constructor(private readonly native: RTCRtpSender) {}

  get track(): MediaStreamTrack | null {
    return this.native.track;
  }

  getParameters(): RTCRtpSendParameters {
    return this.native.getParameters();
  }

  setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    return this.native.setParameters(parameters);
  }

  replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    return this.native.replaceTrack(track);
  }
}

class BrowserRtcRtpTransceiver implements RtcRtpTransceiver {
  readonly sender: RtcRtpSender;
  readonly receiver: RtcRtpReceiver;

  constructor(
    private readonly native: RTCRtpTransceiver,
    readonly kind: "audio" | "video",
  ) {
    this.sender = new BrowserRtcRtpSender(native.sender);
    const receiver = native.receiver;
    this.receiver = {
      get track(): MediaStreamTrack | null {
        return receiver.track;
      },
    };
  }

  setCodecPreferences(codecs: RTCRtpCodec[]): void {
    this.native.setCodecPreferences(codecs);
  }
}

class BrowserRtcPeerConnection implements RtcPeerConnection {
  onicecandidate: ((event: RtcIceCandidateEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  ontrack: ((event: RtcTrackEvent) => void) | null = null;

  private readonly native: RTCPeerConnection;
  private readonly closed = new AbortController();

  constructor(configuration: RTCConfiguration) {
    this.native = new RTCPeerConnection(configuration);
    this.native.onicecandidate = (event) => {
      this.onicecandidate?.({
        candidate: event.candidate
          ? toIceCandidate(event.candidate.toJSON())
          : null,
      });
    };
    this.native.onconnectionstatechange = () =>
      this.onconnectionstatechange?.();
    this.native.oniceconnectionstatechange = () =>
      this.oniceconnectionstatechange?.();
    this.native.onsignalingstatechange = () => {
      if (this.signalingState === "closed") this.abortIceGatheringWaits();
      this.onsignalingstatechange?.();
    };
    this.native.ontrack = (event) => {
      const transceiver = new BrowserRtcRtpTransceiver(
        event.transceiver,
        toKind(event.track),
      );
      this.ontrack?.({
        track: event.track,
        streams: [...event.streams],
        transceiver,
      });
    };
  }

  get connectionState(): RTCPeerConnectionState {
    return this.native.connectionState;
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.native.iceConnectionState;
  }

  get signalingState(): RTCSignalingState {
    return this.native.signalingState;
  }

  get localDescription(): RtcSessionDescription | null {
    const description = this.native.localDescription;
    return description ? toSessionDescription(description) : null;
  }

  addTransceiver(
    trackOrKind: MediaStreamTrack | "audio" | "video",
    init?: RTCRtpTransceiverInit,
  ): RtcRtpTransceiver {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : toKind(trackOrKind);
    const native =
      typeof trackOrKind === "string"
        ? this.native.addTransceiver(trackOrKind, init)
        : this.native.addTransceiver(trackOrKind, init);
    return new BrowserRtcRtpTransceiver(native, kind);
  }

  getTransceivers(): RtcRtpTransceiver[] {
    return this.native.getTransceivers().map((t) => {
      const kind =
        t.sender.track?.kind === "audio"
          ? "audio"
          : t.receiver.track?.kind === "audio"
            ? "audio"
            : "video";
      return new BrowserRtcRtpTransceiver(t, kind);
    });
  }

  async createOffer(options?: RTCOfferOptions): Promise<RtcSessionDescription> {
    return toSessionDescription(await this.native.createOffer(options));
  }

  async createAnswer(
    options?: RTCAnswerOptions,
  ): Promise<RtcSessionDescription> {
    return toSessionDescription(await this.native.createAnswer(options));
  }

  setLocalDescription(description?: RtcSessionDescription): Promise<void> {
    return this.native.setLocalDescription(description);
  }

  waitForIceGatheringComplete(timeoutMs: number): Promise<void> {
    return waitForIceGathering(this.native, this.closed.signal, timeoutMs);
  }

  setRemoteDescription(description: RtcSessionDescription): Promise<void> {
    return this.native.setRemoteDescription(description);
  }

  addIceCandidate(candidate: RtcIceCandidate | null): Promise<void> {
    return this.native.addIceCandidate(candidate);
  }

  getStats(): Promise<RTCStatsReport> {
    return this.native.getStats();
  }

  close(): void {
    this.native.close();
    this.abortIceGatheringWaits();
  }

  private abortIceGatheringWaits(): void {
    this.closed.abort(new DOMException("連線已關閉", "InvalidStateError"));
  }
}

/** 生產用：瀏覽器原生 RTCPeerConnection 的 adapter。 */
export const browserPeerConnectionFactory: PeerConnectionFactory = (
  configuration,
) => new BrowserRtcPeerConnection(configuration);
