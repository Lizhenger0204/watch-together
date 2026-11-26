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
  applyCodecPreferences,
  browserReceiverCodecCapabilities,
  Emitter,
  isIceConnected,
  TransportError,
  type RtcPeerConnection,
  type TransportStats,
} from "../common";
import {
  closePeerConnection,
  gatheredOffer,
  openPeerConnection,
  relayError,
  sampleStats,
  untilStopped,
} from "./connection";
import { deleteResource, postOffer } from "./http";

interface Run {
  readonly abort: AbortController;
  pc?: RtcPeerConnection;
  location?: string;
  deleted?: boolean;
  /** 已經進入 failed；同一次斷線不再重複回報。 */
  failed?: boolean;
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

  function isFailed(pc: RtcPeerConnection) {
    return (
      pc.connectionState === "failed" || pc.iceConnectionState === "failed"
    );
  }

  /**
   * 沒有 ICE restart：連線失敗時立刻結束當次啟動（若有）、關閉 PC、清除 tracks 與資源，
   * 並解除 `run`／`starting` 讓房間層可以立即重新 start()；晚到的 POST 201 仍由 pull() 補刪。
   */
  function failCurrent(current: Run) {
    if (current.failed) return;
    current.failed = true;
    const active = run === current;
    if (active) {
      run = undefined;
      starting = undefined;
    }
    current.abort.abort();
    closePeerConnection(current.pc);
    release(current);
    clearTracks();
    if (active) {
      setState("failed");
      if (!destroyed)
        events.emit(
          "error",
          new TransportError("RELAY_FAILED", "轉發連線中斷"),
        );
    }
  }

  function watch(current: Run, pc: RtcPeerConnection) {
    const check = () => {
      if (current.abort.signal.aborted || run !== current || current.failed)
        return;
      if (isFailed(pc)) failCurrent(current);
      else if (isIceConnected(pc)) setState("playing");
      else setState("connecting");
    };
    pc.oniceconnectionstatechange = check;
    pc.onconnectionstatechange = check;
    return check;
  }

  /** 拉流途中 watch() 已回報失敗，或 PC 實際狀態已為 failed：這一輪不可再繼續，交給 start() 清理。 */
  function ensureNotFailed(current: Run, pc: RtcPeerConnection) {
    if (current.failed || isFailed(pc))
      throw new TransportError("RELAY_FAILED", "轉發連線中斷");
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
    const capabilities =
      options.getCodecCapabilities ?? browserReceiverCodecCapabilities;
    for (const kind of ["video", "audio"] as const) {
      const transceiver = pc.addTransceiver(kind, { direction: "recvonly" });
      try {
        const codecs = capabilities(kind);
        if (codecs.length > 0) applyCodecPreferences(transceiver, codecs);
      } catch {
        // 收看端可能為舊瀏覽器或拒絕偏好清單，降級沿用瀏覽器預設 codec 順序（§4）。
      }
    }

    // 已取消回 null；沒有有效 offer 會丟 RELAY_FAILED。
    const sdp = await gatheredOffer(pc, signal);
    if (!sdp || signal.aborted) return;
    ensureNotFailed(current, pc);
    const resource = await postOffer(
      options.roomId,
      "whep",
      options.token,
      sdp,
    );
    // 標頭驗證過就記下 Location：停止或中斷時立刻 DELETE，不等本文讀完。
    current.location = resource.location;
    if (signal.aborted) {
      release(current);
      return;
    }
    ensureNotFailed(current, pc);
    const answer = await resource.answer;
    if (signal.aborted) return;
    ensureNotFailed(current, pc);
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    if (signal.aborted) return;
    ensureNotFailed(current, pc);
    sampleStats(pc, "receive", signal, (stats) => {
      if (!destroyed && isIceConnected(pc)) events.emit("stats", stats);
    });
    check();
  }

  function stop() {
    const current = run;
    if (!current) {
      setState("waiting");
      return;
    }
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
      // 停止或連線失敗時 start() 立刻結束；pull() 在背景跑到下一個檢查點收尾。
      starting = untilStopped(pull(current), current.abort.signal).then(
        () => {
          if (current.failed)
            throw new TransportError("RELAY_FAILED", "轉發連線中斷");
          if (current.abort.signal.aborted)
            throw new TransportError("RELAY_FAILED", "轉發已停止");
        },
        (error: unknown) => {
          // 若該輪已確認連線失敗，保留 RELAY_FAILED，不被晚到的 409 等回應蓋過。
          const failure =
            current.failed || (current.pc && isFailed(current.pc))
              ? new TransportError("RELAY_FAILED", "轉發連線中斷")
              : relayError(error, "無法接收轉發");
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
            // watch() 已經回報過這次中斷：不重複發錯誤。
            if (!destroyed && !current.failed) events.emit("error", failure);
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
