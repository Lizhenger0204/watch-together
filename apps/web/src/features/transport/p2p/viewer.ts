import type { SignalData } from "@project/shared";
import type { CreateViewerTransport, ViewerTransportState } from "../index";
import {
  browserPeerConnectionFactory,
  Emitter,
  isIceConnected,
  loadIceServers,
  TransportError,
  type RtcPeerConnection,
  type TransportStats,
} from "../common";
import { Negotiation, peerError, subscribeUntilStopped } from "./negotiation";

interface Reception {
  round: Negotiation;
  sessionId?: string;
  pc?: RtcPeerConnection;
  answered: boolean;
}

export const createP2PViewerTransport: CreateViewerTransport = (options) => {
  const remoteStream = new MediaStream();
  const events = new Emitter<{
    state: [ViewerTransportState];
    stats: [TransportStats];
    error: [TransportError];
  }>();
  let state: ViewerTransportState = "waiting";
  let run: AbortController | undefined;
  let current: Reception | undefined;
  let destroyed = false;

  function setState(next: ViewerTransportState) {
    if (destroyed || next === state) return;
    state = next;
    events.emit("state", next);
  }

  function clearTracks() {
    for (const track of remoteStream.getTracks())
      remoteStream.removeTrack(track);
  }

  function closeReception() {
    if (!current) return;
    current.round.cancel();
    const pc = current.pc;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    current = undefined;
  }

  function fail(round: Negotiation, error: unknown) {
    if (!round.active) return;
    const session = run;
    closeReception();
    setState("failed");
    if (!destroyed && run === session && !current)
      events.emit("error", peerError(error));
  }

  function observe(reception: Reception, pc: RtcPeerConnection) {
    if (!reception.round.active) return;
    if (pc.connectionState === "failed" && isIceConnected(pc)) {
      fail(reception.round, new TransportError("PEER_FAILED", "影音連線失敗"));
    } else if (pc.iceConnectionState === "failed") {
      // Keep the receivers alive: the host may still send a restart offer on this PC.
      setState("failed");
    } else if (isIceConnected(pc) && reception.answered) setState("playing");
    else setState("connecting");
  }

  async function answer(reception: Reception, sdp: string) {
    const { round } = reception;
    try {
      let pc = reception.pc;
      if (!pc) {
        const iceServers = await loadIceServers(options, round.signal);
        if (!round.active) return;
        pc = (options.createPeerConnection ?? browserPeerConnectionFactory)({
          iceServers,
        });
        reception.pc = pc;
      }
      const connection = pc;
      round.attach(pc, "receive", (stats) => events.emit("stats", stats));
      pc.ontrack = ({ track }) => {
        if (round.active) remoteStream.addTrack(track);
      };
      pc.oniceconnectionstatechange = pc.onconnectionstatechange = () =>
        observe(reception, connection);
      await pc.setRemoteDescription({ type: "offer", sdp });
      if (!round.active) return;
      round.remoteDescriptionApplied(sdp);
      if (!round.active) return;
      const description = await pc.createAnswer();
      if (!round.active) return;
      await round.publish(pc, description, () => {
        reception.answered = true;
      });
      observe(reception, pc);
    } catch (error) {
      fail(round, error);
    }
  }

  function receive(from: string, data: SignalData) {
    const previous = current;
    const matches =
      previous?.round.memberId === from &&
      previous.round.id === data.negotiationId;
    if (data.type === "ice") {
      if (matches) previous.round.addRemoteIce(data.candidate);
      return;
    }
    if (data.type !== "offer" || matches) return;
    // The SDP origin's session id stays fixed across ICE restarts; its version changes.
    const sessionId = /^o=\S+\s+(\S+)/m.exec(data.sdp)?.[1];
    const reuse =
      previous?.answered &&
      previous.round.memberId === from &&
      previous.sessionId === sessionId;
    const round: Negotiation = new Negotiation(
      data.negotiationId,
      from,
      options.signal,
      (error) => fail(round, error),
      !reuse || previous.round.nextGatheringIsUnambiguous,
    );
    if (reuse) previous.round.cancel();
    else {
      closeReception();
      clearTracks();
    }
    const reception = {
      round,
      sessionId,
      pc: reuse ? previous.pc : undefined,
      answered: false,
    };
    current = reception;
    setState("connecting");
    if (round.active) void answer(reception, data.sdp);
  }

  function stop() {
    if (!run) return;
    run.abort();
    run = undefined;
    closeReception();
    clearTracks();
    setState("waiting");
  }

  return {
    mode: "p2p",
    remoteStream,
    async start() {
      if (destroyed) throw new TransportError("PEER_FAILED", "傳輸已銷毀");
      if (run?.signal.aborted)
        throw new TransportError("SIGNAL_ERROR", "無法訂閱連線信令");
      if (run) return;
      run = new AbortController();
      const { signal } = run;
      setState("connecting");
      try {
        subscribeUntilStopped(
          signal,
          options.signal.onSignal(({ from, data }) => {
            if (!signal.aborted) receive(from, data);
          }),
        );
      } catch {
        const error = new TransportError("SIGNAL_ERROR", "無法訂閱連線信令");
        if (!signal.aborted) {
          run.abort();
          closeReception();
          setState("failed");
          if (run?.signal === signal && !destroyed) events.emit("error", error);
        }
        throw error;
      }
    },
    stop,
    onState: (handler) => events.on("state", handler),
    onStats: (handler) => events.on("stats", handler),
    onError: (handler) => events.on("error", handler),
    destroy() {
      destroyed = true;
      events.removeAll();
      stop();
    },
  };
};
