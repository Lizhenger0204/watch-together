/**
 * RTCPeerConnection 的最小介面。
 *
 * 傳輸層只透過這些介面碰 WebRTC，單元測試用 `rtc-fake.ts` 的 fake 實作，
 * 不依賴真實瀏覽器（testing.md）。瀏覽器原生 `RTCPeerConnection` 與這些介面
 * 結構相容，由 `browserPeerConnectionFactory` 包一層（見下方）。
 *
 * 介面只宣告傳輸層需要的成員；事件型別（`RtcIceCandidateEvent`、`RtcTrackEvent`）
 * 用最小結構，方便在 Node 測試環境實作 fake。
 */

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

/** onicecandidate 事件：`candidate === null` 代表 end-of-candidates。 */
export interface RtcIceCandidateEvent {
  candidate: RTCIceCandidateInit | null;
}

/** ontrack 事件：收看端由此拿到 remote stream。 */
export interface RtcTrackEvent {
  track: MediaStreamTrack;
  streams: readonly MediaStream[];
  transceiver: RtcRtpTransceiver;
}

/** RTCPeerConnection 最小介面。 */
export interface RtcPeerConnection {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly signalingState: RTCSignalingState;

  addTransceiver(
    trackOrKind: MediaStreamTrack | "audio" | "video",
    init?: RTCRtpTransceiverInit,
  ): RtcRtpTransceiver;
  getTransceivers(): RtcRtpTransceiver[];
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(
    description?: RTCLocalSessionDescriptionInit,
  ): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
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

/** 生產用：瀏覽器原生 RTCPeerConnection。 */
export const browserPeerConnectionFactory: PeerConnectionFactory = (
  configuration,
) => new RTCPeerConnection(configuration) as unknown as RtcPeerConnection;
