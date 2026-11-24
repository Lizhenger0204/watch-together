/**
 * 轉發模式的收看者傳輸（WHEP，docs/specs/streaming.md §4、§9）。
 *
 * - video、audio 各一個 recvonly transceiver，單次 HTTP offer 拉取房主發布的 track。
 * - `remoteStream` 建立時就固定；ontrack 用 `event.track` 加入，stop() 時移除。
 * - WHEP 回 409：回到 `waiting` 並以 STREAM_NOT_LIVE 結束這次 start()（非致命）。
 * - 沒有 ICE restart：連線失敗就進 `failed`，由房間層重新 start() 拉取。
 * - 拿到 `201` 的資源在 stop／destroy 時 DELETE，停止後才到的回應也一樣。
 */
import type { CreateViewerTransport, ViewerTransportState } from "../index";
import {
  Emitter,
  TransportError,
  type RtcPeerConnection,
  type TransportStats,
} from "../common";
import {
  closePeerConnection,
  gatheredOffer,
  isIceConnected,
  openPeerConnection,
  relayError,
  sampleStats,
} from "./connection";
import { deleteResource, postOffer } from "./http";

interface Run {
  readonly abort: AbortController;
  pc?: RtcPeerConnection;
  location?: string;
  deleted?: boolean;
}

export const createRelayViewerTransport: CreateViewerTransport = (options) => {
  const remoteStream = new MediaStream();
  const events = new Emitter<{
    state: [ViewerTransportState];
    stats: [TransportStats];
    error: [TransportError];
  }>();
  let state: ViewerTransportState = "waiting";
  let run: Run | undefined;
  let starting: Promise<void> | undefined;
  let destroyed = false;

  function setState(next: ViewerTransportState) {
    if (destroyed || state === next) return;
    state = next;
    events.emit("state", next);
  }

  function clearTracks() {
    for (const track of remoteStream.getTracks())
      remoteStream.removeTrack(track);
  }

  /** 有資源就 DELETE（含重試）；同一個資源只刪一次。 */
  function release(current: Run) {
    if (!current.location || current.deleted) return;
    current.deleted = true;
    void deleteResource(current.location, options.token);
  }

  function watch(current: Run, pc: RtcPeerConnection) {
    const check = () => {
      if (current.abort.signal.aborted || run !== current) return;
      if (
        pc.connectionState === "failed" ||
        pc.iceConnectionState === "failed"
      ) {
        setState("failed");
        if (!destroyed)
          events.emit(
            "error",
            new TransportError("RELAY_FAILED", "轉發連線中斷"),
          );
      } else if (isIceConnected(pc)) setState("playing");
      else setState("connecting");
    };
    pc.oniceconnectionstatechange = check;
    pc.onconnectionstatechange = check;
    return check;
  }

  async function pull(current: Run) {
    const { signal } = current.abort;
    const pc = await openPeerConnection(options, signal);
    if (!pc) return;
    current.pc = pc;
    if (signal.aborted) {
      closePeerConnection(pc);
      return;
    }
    const check = watch(current, pc);
    pc.ontrack = ({ track }) => {
      if (!signal.aborted) remoteStream.addTrack(track);
    };
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    const sdp = await gatheredOffer(pc, signal);
    if (!sdp) return;
    const resource = await postOffer(
      options.roomId,
      "whep",
      options.token,
      sdp,
    );
    current.location = resource.location;
    if (signal.aborted) {
      release(current);
      return;
    }
    await pc.setRemoteDescription({ type: "answer", sdp: resource.answer });
    if (signal.aborted) return;
    sampleStats(pc, "receive", signal, (stats) => {
      if (!destroyed && isIceConnected(pc)) events.emit("stats", stats);
    });
    check();
  }

  function stop() {
    const current = run;
    if (!current) return;
    run = undefined;
    starting = undefined;
    current.abort.abort();
    closePeerConnection(current.pc);
    release(current);
    clearTracks();
    setState("waiting");
  }

  return {
    mode: "relay",
    remoteStream,
    start() {
      if (destroyed)
        return Promise.reject(new TransportError("RELAY_FAILED", "傳輸已銷毀"));
      if (starting) return starting;
      const current: Run = { abort: new AbortController() };
      run = current;
      setState("connecting");
      starting = pull(current).then(
        () => {
          if (current.abort.signal.aborted)
            throw new TransportError("RELAY_FAILED", "轉發已停止");
        },
        (error: unknown) => {
          const failure = relayError(error, "無法接收轉發");
          // 套用 answer 失敗等情況：已建立的資源也要清掉。
          release(current);
          if (run === current) {
            run = undefined;
            starting = undefined;
            current.abort.abort();
            closePeerConnection(current.pc);
            clearTracks();
            // 房主尚未開播（409）不是致命錯誤：回到 waiting，等開播廣播再拉。
            setState(failure.code === "STREAM_NOT_LIVE" ? "waiting" : "failed");
            if (!destroyed) events.emit("error", failure);
          }
          throw failure;
        },
      );
      return starting;
    },
    stop,
    onState: (handler) => events.on("state", handler),
    onStats: (handler) => events.on("stats", handler),
    onError: (handler) => events.on("error", handler),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      events.removeAll();
      stop();
    },
  };
};
