import type { SignalData } from "@project/shared";
import type { TransportSignal } from "../index";
import {
  StatsSampler,
  TransportError,
  type RtcIceCandidate,
  type RtcPeerConnection,
  type RtcSessionDescription,
  type StatsDirection,
  type TransportStats,
} from "../common";

type Candidate = RtcIceCandidate | null;

/** A media-level ICE credential overrides the session default, including in non-BUNDLE SDP. */
class IceCredentials {
  private readonly session?: string;
  private readonly media: { mid?: string; ufrag?: string }[];

  constructor(sdp: string) {
    const [session, ...media] = sdp.split(/\r?\n(?=m=)/);
    this.session = /^a=ice-ufrag:(\S+)/m.exec(session ?? "")?.[1];
    this.media = media.map((section) => ({
      mid: /^a=mid:(\S+)/m.exec(section)?.[1],
      ufrag: /^a=ice-ufrag:(\S+)/m.exec(section)?.[1] ?? this.session,
    }));
  }

  matches(candidate: RtcIceCandidate, fragment: string): boolean {
    if (candidate.sdpMid != null) {
      return (
        this.media.find((m) => m.mid === candidate.sdpMid)?.ufrag === fragment
      );
    }
    if (candidate.sdpMLineIndex != null) {
      return this.media[candidate.sdpMLineIndex]?.ufrag === fragment;
    }
    return this.media.length
      ? this.media.every((m) => m.ufrag === fragment)
      : this.session === fragment;
  }
}

function fragmentOf(candidate: Candidate) {
  return (
    candidate?.usernameFragment ??
    /(?:^|\s)ufrag\s+(\S+)/.exec(candidate?.candidate ?? "")?.[1]
  );
}

export function peerError(cause: unknown, memberId?: string) {
  const error =
    cause instanceof TransportError
      ? cause
      : new TransportError("PEER_FAILED", "無法建立影音連線");
  return new TransportError(error.code, error.message, { memberId });
}

export function subscribeUntilStopped(
  signal: AbortSignal,
  unsubscribe: () => void,
) {
  // A signal adapter may synchronously deliver buffered messages during subscription.
  if (signal.aborted) unsubscribe();
  else signal.addEventListener("abort", unsubscribe, { once: true });
}

/** One offer owns both trickle queues, the sample baseline and all its async continuations. */
export class Negotiation {
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  private pc?: RtcPeerConnection;
  private local?: IceCredentials;
  private remote?: IceCredentials;
  private localSent = false;
  private gatheringEnded = false;
  private readonly outgoing: Candidate[] = [];
  private readonly incoming: Candidate[] = [];
  private draining = false;
  private statsTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly id: string,
    readonly memberId: string,
    private readonly signaling: TransportSignal,
    private readonly onFailure: (error: TransportError) => void,
    private readonly singleGathering = true,
  ) {}

  get active() {
    return !this.signal.aborted;
  }

  /** Without a ufrag, a late event (also null) cannot identify an overlapping gathering. */
  get nextGatheringIsUnambiguous() {
    return this.singleGathering && (!this.local || this.gatheringEnded);
  }

  attach(
    pc: RtcPeerConnection,
    direction: StatsDirection,
    onStats: (stats: TransportStats) => void,
  ) {
    this.pc = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (!this.active || !this.local) return;
      const fragment = fragmentOf(candidate);
      if (candidate && fragment) {
        if (!this.local.matches(candidate, fragment)) return;
      } else if (!this.singleGathering) return;
      if (candidate === null) this.gatheringEnded = true;
      if (this.localSent) this.sendIce(candidate);
      else this.outgoing.push(candidate);
    };

    const sampler = new StatsSampler(() => pc.getStats(), direction);
    let sampling = false;
    this.statsTimer = setInterval(async () => {
      if (!this.active || sampling) return;
      sampling = true;
      try {
        const stats = await sampler.sample();
        if (this.active) onStats(stats);
      } catch {
        // Statistics are best effort. A missing sample must not tear down media.
      } finally {
        sampling = false;
      }
    }, 2_000);
  }

  async publish(
    pc: RtcPeerConnection,
    description: RtcSessionDescription,
    beforeSend: () => void,
    wireSdp?: string,
  ) {
    this.local = new IceCredentials(description.sdp);
    await pc.setLocalDescription(description);
    if (!this.active) return;
    beforeSend();
    this.send({
      ...description,
      sdp: wireSdp ?? description.sdp,
      negotiationId: this.id,
    });
    this.localSent = true;
    for (const candidate of this.outgoing.splice(0)) this.sendIce(candidate);
  }

  addRemoteIce(candidate: Candidate) {
    this.incoming.push(candidate);
    void this.drainRemoteIce();
  }

  remoteDescriptionApplied(sdp: string) {
    this.remote = new IceCredentials(sdp);
    void this.drainRemoteIce();
  }

  private async drainRemoteIce() {
    if (!this.pc || !this.remote || this.draining) return;
    this.draining = true;
    try {
      while (this.active && this.incoming.length) {
        const candidate = this.incoming.shift() ?? null;
        const fragment = fragmentOf(candidate);
        if (candidate && fragment && !this.remote.matches(candidate, fragment))
          continue;
        await this.pc.addIceCandidate(candidate);
      }
    } catch {
      if (this.active)
        this.onFailure(new TransportError("SIGNAL_ERROR", "無法套用遠端 ICE"));
    } finally {
      this.draining = false;
    }
  }

  private sendIce(candidate: Candidate) {
    this.send({ type: "ice", negotiationId: this.id, candidate });
  }

  private send(data: SignalData) {
    if (!this.active) return;
    try {
      if (this.signaling.sendSignal(this.memberId, data)) return;
    } catch {
      // A closed socket may also throw synchronously.
    }
    if (this.active) {
      this.onFailure(new TransportError("SIGNAL_ERROR", "無法送出連線信令"));
    }
  }

  cancel() {
    this.lifetime.abort();
    clearInterval(this.statsTimer);
    this.outgoing.length = 0;
    this.incoming.length = 0;
  }
}
