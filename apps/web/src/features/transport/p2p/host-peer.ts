import {
  QUALITY_PRESETS,
  type MemberState,
  type Quality,
  type SignalData,
} from "@project/shared";
import type { HostTransportOptions } from "../index";
import {
  applyAudioEncoding,
  applyCodecPreferences,
  applyVideoEncoding,
  browserCodecCapabilities,
  browserPeerConnectionFactory,
  TransportError,
  type RtcPeerConnection,
  type RtcRtpSender,
  type TransportStats,
} from "../common";
import {
  isIceConnected,
  loadIceServers,
  Negotiation,
  peerError,
} from "./negotiation";

export type MediaKind = "video" | "audio";
export interface HostSource {
  tracks: Partial<Record<MediaKind, MediaStreamTrack | null>>;
  quality: Quality;
}

interface PeerEvents {
  state: (state: MemberState) => void;
  stats: (stats: TransportStats) => void;
  error: (error: TransportError) => void;
  remove: () => void;
}

const ANSWER_TIMEOUT_MS = 15_000;
const DISCONNECTED_GRACE_MS = 5_000;
const MAX_RESTARTS = 3;

export class HostPeer {
  private round: Negotiation;
  private pc?: RtcPeerConnection;
  private senders?: Record<MediaKind, RtcRtpSender>;
  private phase: "preparing" | "waiting" | "applying" | "answered" =
    "preparing";
  private restarts = 0;
  private playing = false;
  private answerTimer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private disconnectDue = false;
  // Serialize SDP and sender operations on this PC. A setParameters transaction
  // must not race another setParameters or a pending description change.
  private pending = Promise.resolve();

  constructor(
    private readonly memberId: string,
    private readonly options: HostTransportOptions,
    private readonly source: HostSource,
    private readonly events: PeerEvents,
  ) {
    this.round = this.newRound(true);
  }

  private newRound(singleGathering: boolean) {
    return new Negotiation(
      crypto.randomUUID(),
      this.memberId,
      this.options.signal,
      (error) => this.fail(error),
      singleGathering,
    );
  }

  start() {
    this.armAnswerTimer(this.round);
    this.events.state("connecting");
    if (this.round.active) void this.connect(this.round);
  }

  private async connect(round: Negotiation) {
    try {
      const iceServers = await loadIceServers(this.options, round.signal);
      if (!round.active) return;
      const pc = (
        this.options.createPeerConnection ?? browserPeerConnectionFactory
      )({ iceServers });
      this.pc = pc;
      this.bind(pc, round);
      try {
        const add = (kind: MediaKind) => {
          const transceiver = pc.addTransceiver(
            this.source.tracks[kind] ?? kind,
            { direction: "sendonly" },
          );
          const capabilities =
            this.options.getCodecCapabilities ?? browserCodecCapabilities;
          applyCodecPreferences(transceiver, capabilities(kind));
          return transceiver.sender;
        };
        this.senders = { video: add("video"), audio: add("audio") };
      } catch {
        throw this.trackError();
      }
      await this.offer(pc, round, false);
    } catch (error) {
      if (round.active) this.fail(error);
    }
  }

  private bind(pc: RtcPeerConnection, round: Negotiation) {
    round.attach(pc, "send", this.events.stats);
    pc.oniceconnectionstatechange = () => {
      if (round.active) this.observeIce(pc, round);
    };
    pc.onconnectionstatechange = () => {
      // A DTLS failure with healthy ICE cannot be recovered by an ICE restart.
      if (
        round.active &&
        pc.connectionState === "failed" &&
        isIceConnected(pc)
      ) {
        this.fail(new TransportError("PEER_FAILED", "影音連線失敗"));
      }
    };
  }

  private enqueue(round: Negotiation, operation: () => Promise<void>) {
    const result = this.pending.then(() => {
      if (round.active) return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }

  private trackError() {
    return new TransportError("TRACK_ERROR", "無法套用影音軌或編碼設定", {
      memberId: this.memberId,
    });
  }

  private async applyMedia(change: MediaKind | "quality", round: Negotiation) {
    const kind = change === "quality" ? "video" : change;
    const sender = this.senders?.[kind];
    if (!sender || !round.active) return;
    const track = this.source.tracks[kind] ?? null;
    try {
      if (change !== "quality" && sender.track !== track) {
        await sender.replaceTrack(track);
        if (!round.active) return;
      }
      if (kind === "audio") {
        await applyAudioEncoding(sender);
      } else {
        await applyVideoEncoding(
          sender,
          QUALITY_PRESETS[this.source.quality],
          sender.track?.getSettings().height ?? 0,
        );
      }
    } catch {
      if (round.active) throw this.trackError();
    }
  }

  async updateMedia(change: MediaKind | "quality") {
    if (!this.senders || !this.round.active) return;
    const round = this.round;
    // A closed PC need not settle an outstanding native operation. Release
    // callers on retirement, but keep actual work on a reused PC serialized.
    let release!: () => void;
    const retired = new Promise<void>((resolve) => {
      release = resolve;
    });
    round.signal.addEventListener("abort", release, { once: true });
    try {
      await Promise.race([
        this.enqueue(round, () => this.applyMedia(change, round)),
        retired,
      ]);
    } catch (error) {
      if (!round.active) return;
      const failure = peerError(error, this.memberId);
      this.events.error(failure);
      throw failure;
    } finally {
      round.signal.removeEventListener("abort", release);
    }
  }

  private offer(pc: RtcPeerConnection, round: Negotiation, restart: boolean) {
    return this.enqueue(round, async () => {
      // A restart may have cancelled a queued track/quality change on these same senders.
      await this.applyMedia("video", round);
      await this.applyMedia("audio", round);
      if (!round.active) return;
      const description = await pc.createOffer(
        restart ? { iceRestart: true } : undefined,
      );
      if (!round.active) return;
      await round.publish(pc, description, () => {
        this.phase = "waiting";
        if (restart) this.armAnswerTimer(round);
      });
    });
  }

  receive(data: SignalData) {
    const round = this.round;
    if (!round.active || data.negotiationId !== round.id) return;
    if (data.type === "ice") {
      round.addRemoteIce(data.candidate);
      return;
    }
    const pc = this.pc;
    if (data.type !== "answer" || this.phase !== "waiting" || !pc) return;
    this.phase = "applying";
    clearTimeout(this.answerTimer);
    void this.enqueue(round, async () => {
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      if (!round.active) return;
      round.remoteDescriptionApplied(data.sdp);
      if (!round.active) return;
      this.phase = "answered";
      this.observeIce(pc, round);
    }).catch((error: unknown) => {
      if (round.active) this.fail(error);
    });
  }

  private armAnswerTimer(round: Negotiation) {
    this.answerTimer = setTimeout(() => {
      if (round.active)
        this.fail(new TransportError("PEER_FAILED", "等待收看者回應逾時"));
    }, ANSWER_TIMEOUT_MS);
  }

  private observeIce(pc: RtcPeerConnection, round: Negotiation) {
    if (pc.iceConnectionState !== "disconnected") this.clearDisconnect();
    if (isIceConnected(pc)) {
      this.restarts = 0;
      if (this.phase === "answered" && !this.playing) {
        this.playing = true;
        this.events.state("playing");
      }
    } else if (pc.iceConnectionState === "failed") {
      this.restart(pc);
    } else if (pc.iceConnectionState === "disconnected") {
      if (this.disconnectDue) this.restart(pc);
      else if (this.disconnectTimer === undefined) {
        this.disconnectTimer = setTimeout(() => {
          if (!round.active || pc.iceConnectionState !== "disconnected") return;
          this.disconnectDue = true;
          this.restart(pc);
        }, DISCONNECTED_GRACE_MS);
      }
    }
  }

  private restart(pc: RtcPeerConnection) {
    // Never supersede an unanswered offer. Its own deadline still applies.
    if (this.phase !== "answered") return;
    if (this.restarts >= MAX_RESTARTS) {
      this.fail(new TransportError("PEER_FAILED", "ICE 重新連線失敗"));
      return;
    }
    this.restarts++;
    this.clearDisconnect();
    const next = this.newRound(this.round.nextGatheringIsUnambiguous);
    this.round.cancel();
    this.round = next;
    this.phase = "preparing";
    this.playing = false;
    this.bind(pc, next);
    this.events.state("connecting");
    void this.offer(pc, next, true).catch((error: unknown) => {
      if (next.active) this.fail(error);
    });
  }

  private clearDisconnect() {
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    this.disconnectDue = false;
  }

  private fail(error: unknown) {
    const round = this.round;
    if (!round.active) return;
    this.events.state("failed");
    if (round.active) this.events.error(peerError(error, this.memberId));
    if (round.active) this.events.remove();
  }

  close() {
    this.round.cancel();
    clearTimeout(this.answerTimer);
    this.clearDisconnect();
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
  }
}
