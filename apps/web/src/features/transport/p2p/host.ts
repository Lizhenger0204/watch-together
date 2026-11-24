import type { MemberState } from "@project/shared";
import type { CreateHostTransport, HostTransportState } from "../index";
import {
  Emitter,
  setVideoContentHint,
  TransportError,
  type TransportStats,
} from "../common";
import { HostPeer, type HostSource, type MediaKind } from "./host-peer";
import { subscribeUntilStopped } from "./negotiation";

export const createP2PHostTransport: CreateHostTransport = (options) => {
  const events = new Emitter<{
    state: [HostTransportState];
    peerState: [{ memberId: string; state: MemberState }];
    stats: [TransportStats & { memberId: string }];
    error: [TransportError];
  }>();
  const peers = new Map<string, HostPeer>();
  const source: HostSource = { tracks: {}, quality: options.quality };
  let run: AbortController | undefined;
  let destroyed = false;
  let startError: TransportError | undefined;

  function rememberTrack(kind: MediaKind, track: MediaStreamTrack | null) {
    source.tracks[kind] = track;
    if (kind === "video" && track) setVideoContentHint(track);
  }

  function removePeer(memberId: string) {
    const peer = peers.get(memberId);
    peers.delete(memberId);
    peer?.close();
  }

  function request(memberId: string) {
    removePeer(memberId);
    const peer = new HostPeer(memberId, options, source, {
      state: (state) => events.emit("peerState", { memberId, state }),
      stats: (stats) => events.emit("stats", { memberId, ...stats }),
      error: (error) => events.emit("error", error),
      remove: () => removePeer(memberId),
    });
    peers.set(memberId, peer);
    peer.start();
  }

  function stop() {
    if (!run) return;
    run.abort();
    run = undefined;
    for (const memberId of peers.keys()) removePeer(memberId);
    if (!destroyed && !startError) events.emit("state", "idle");
  }

  return {
    mode: "p2p",
    stream: options.stream,
    async start() {
      if (destroyed) throw new TransportError("PEER_FAILED", "傳輸已銷毀");
      if (startError) throw startError;
      if (run) return;
      for (const kind of ["video", "audio"] as const) {
        if (source.tracks[kind] !== undefined) continue;
        const tracks =
          kind === "video"
            ? options.stream.getVideoTracks()
            : options.stream.getAudioTracks();
        rememberTrack(
          kind,
          tracks.find((track) => track.readyState !== "ended") ?? null,
        );
      }
      run = new AbortController();
      const { signal } = run;
      try {
        subscribeUntilStopped(
          signal,
          options.signal.onSignal(({ from, data }) => {
            if (!signal.aborted) peers.get(from)?.receive(data);
          }),
        );
        subscribeUntilStopped(
          signal,
          options.signal.onPeerRequest(({ memberId }) => {
            if (!signal.aborted) request(memberId);
          }),
        );
      } catch {
        const error = new TransportError("SIGNAL_ERROR", "無法訂閱連線信令");
        if (!signal.aborted) {
          startError = error;
          stop();
          events.emit("state", "error");
          if (!destroyed) events.emit("error", error);
        }
        throw error;
      }
      if (!signal.aborted) events.emit("state", "live");
    },
    stop,
    removePeer,
    replaceTrack(kind, track) {
      if (destroyed) return;
      rememberTrack(kind, track);
      for (const peer of peers.values()) {
        // The void API reports track errors through onError.
        void peer.updateMedia(kind).catch(() => {});
      }
    },
    async setQuality(quality) {
      if (destroyed) throw new TransportError("PEER_FAILED", "傳輸已銷毀");
      source.quality = quality;
      let firstError: unknown;
      for (const peer of [...peers.values()]) {
        try {
          await peer.updateMedia("quality");
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    },
    onState: (handler) => events.on("state", handler),
    onPeerState: (handler) => events.on("peerState", handler),
    onStats: (handler) => events.on("stats", handler),
    onError: (handler) => events.on("error", handler),
    destroy() {
      destroyed = true;
      events.removeAll();
      stop();
    },
  };
};
