/**
 * 轉發模式的房主傳輸（WHIP，docs/specs/streaming.md §4、§9）。
 *
 * - 單一上傳：一條 RTCPeerConnection 送到 Cloudflare Realtime，收看者由 SFU 轉發。
 * - 首次 offer 一律保留 video、audio 各一個 sendonly transceiver（缺軌時 track 為 null），
 *   之後換片或補軌都用同一個 sender 的 replaceTrack，不必重新協商。
 * - 同一房間的 WHIP 建立與刪除透過 PublishQueue 依序完成。
 * - `removePeer` 在轉發模式是 no-op：收看者各自向 SFU 拉流，房主端沒有逐人的連線。
 */
import { QUALITY_PRESETS, type Quality } from "@project/shared";
import type { CreateHostTransport, HostTransportState } from "../index";
import {
  applyAudioEncoding,
  applyCodecPreferences,
  applyVideoEncoding,
  browserCodecCapabilities,
  Emitter,
  isIceConnected,
  setVideoContentHint,
  TransportError,
  type RtcPeerConnection,
  type RtcRtpSender,
  type TransportStats,
} from "../common";
import {
  closePeerConnection,
  gatheredOffer,
  openPeerConnection,
  relayError,
  sampleStats,
} from "./connection";
import { postOffer } from "./http";
import { publishQueue } from "./publish-queue";

type MediaKind = "video" | "audio";

/** 一次 start() 到 stop() 的發布。 */
interface Run {
  readonly abort: AbortController;
  release?: () => void;
  location?: string;
  pc?: RtcPeerConnection;
  senders?: Record<MediaKind, RtcRtpSender>;
  /** 同一條連線上的 sender 操作依序執行（setParameters 不可並行）。 */
  pending: Promise<void>;
  cleanup?: Promise<void>;
  /** publish() 已經跑完（成功開播）。還沒跑完時由 publish() 在下一個檢查點自行清理。 */
  published?: boolean;
}

export const createRelayHostTransport: CreateHostTransport = (options) => {
  const events = new Emitter<{
    state: [HostTransportState];
    stats: [TransportStats];
    error: [TransportError];
  }>();
  const queue = publishQueue(options.roomId);
  const tracks: Partial<Record<MediaKind, MediaStreamTrack | null>> = {};
  let quality: Quality = options.quality;
  let state: HostTransportState = "idle";
  let run: Run | undefined;
  let starting: Promise<void> | undefined;
  let destroyed = false;

  function setState(next: HostTransportState) {
    if (destroyed || state === next) return;
    state = next;
    events.emit("state", next);
  }

  function emitError(error: TransportError) {
    if (!destroyed) events.emit("error", error);
  }

  function rememberTrack(kind: MediaKind, track: MediaStreamTrack | null) {
    tracks[kind] = track;
    if (kind === "video" && track) setVideoContentHint(track);
  }

  function trackError(cause?: unknown) {
    return new TransportError("TRACK_ERROR", "無法套用影音軌或編碼設定", {
      cause,
    });
  }

  /** 把最新 track 與畫質套到 sender。 */
  async function applyMedia(current: Run, change: MediaKind | "quality") {
    const kind = change === "quality" ? "video" : change;
    const sender = current.senders?.[kind];
    if (!sender || current.abort.signal.aborted) return;
    const track = tracks[kind] ?? null;
    try {
      if (change !== "quality" && sender.track !== track) {
        await sender.replaceTrack(track);
        if (current.abort.signal.aborted) return;
      }
      if (kind === "audio") await applyAudioEncoding(sender);
      else
        await applyVideoEncoding(
          sender,
          QUALITY_PRESETS[quality],
          sender.track?.getSettings().height ?? 0,
        );
    } catch (error) {
      if (!current.abort.signal.aborted) throw trackError(error);
    }
  }

  function enqueue(current: Run, operation: () => Promise<void>) {
    const result = current.pending.then(() => {
      if (!current.abort.signal.aborted) return operation();
    });
    current.pending = result.catch(() => {});
    return result;
  }

  /** 釋放這一輪：有資源就 DELETE（含重試），之後才讓下一次 WHIP POST。 */
  function cleanup(current: Run) {
    current.cleanup ??= (async () => {
      try {
        if (current.location)
          await queue.remove(current.location, options.token);
      } finally {
        current.release?.();
      }
    })();
    return current.cleanup;
  }

  /** 已取消的發布：清理在背景完成，start() 不必等 DELETE。 */
  function abandon(current: Run) {
    void cleanup(current);
  }

  function watch(current: Run, pc: RtcPeerConnection) {
    const check = () => {
      if (current.abort.signal.aborted || run !== current) return;
      if (
        pc.connectionState === "failed" ||
        pc.iceConnectionState === "failed"
      ) {
        setState("error");
        emitError(new TransportError("RELAY_FAILED", "轉發連線中斷"));
      }
    };
    pc.oniceconnectionstatechange = check;
    pc.onconnectionstatechange = check;
  }

  async function publish(current: Run) {
    const { signal } = current.abort;
    current.release = await queue.turn();
    if (signal.aborted) return abandon(current);
    try {
      await queue.flushLeftovers(options.token);
      if (signal.aborted) return abandon(current);

      const pc = await openPeerConnection(options, signal);
      if (!pc) return abandon(current);
      current.pc = pc;
      if (signal.aborted) {
        closePeerConnection(pc);
        return abandon(current);
      }
      watch(current, pc);
      try {
        const capabilities =
          options.getCodecCapabilities ?? browserCodecCapabilities;
        const add = (kind: MediaKind) => {
          const transceiver = pc.addTransceiver(tracks[kind] ?? kind, {
            direction: "sendonly",
          });
          applyCodecPreferences(transceiver, capabilities(kind));
          return transceiver.sender;
        };
        current.senders = { video: add("video"), audio: add("audio") };
      } catch (error) {
        throw trackError(error);
      }
      await enqueue(current, async () => {
        await applyMedia(current, "video");
        await applyMedia(current, "audio");
      });

      const sdp = await gatheredOffer(pc, signal);
      // 已取消或沒有有效 offer：不送 POST。
      if (!sdp) return abandon(current);

      const resource = await postOffer(
        options.roomId,
        "whip",
        options.token,
        sdp,
      );
      // 取得 Location 後一律記下，停止或失敗時都依它 DELETE。
      current.location = resource.location;
      if (signal.aborted) return abandon(current);

      await pc.setRemoteDescription({ type: "answer", sdp: resource.answer });
      if (signal.aborted) return abandon(current);
      sampleStats(pc, "send", signal, (stats) => {
        if (!destroyed && isIceConnected(pc)) events.emit("stats", stats);
      });
      current.published = true;
      setState("live");
    } catch (error) {
      void cleanup(current);
      throw relayError(error, "無法開始轉發");
    }
  }

  function stop() {
    const current = run;
    if (!current) return;
    run = undefined;
    starting = undefined;
    current.abort.abort();
    closePeerConnection(current.pc);
    // 發布還沒跑完（含 POST 在途）時，publish() 在下一個檢查點自己 cleanup，
    // 不能在這裡先釋放輪次，否則下一次 WHIP 可能比舊 POST 的回應先到。
    if (current.published) void cleanup(current);
    setState("idle");
  }

  return {
    mode: "relay",
    stream: options.stream,
    start() {
      if (destroyed)
        return Promise.reject(new TransportError("RELAY_FAILED", "傳輸已銷毀"));
      if (starting) return starting;
      for (const kind of ["video", "audio"] as const) {
        if (tracks[kind] !== undefined) continue;
        const candidates =
          kind === "video"
            ? options.stream.getVideoTracks()
            : options.stream.getAudioTracks();
        rememberTrack(
          kind,
          candidates.find((track) => track.readyState !== "ended") ?? null,
        );
      }
      const current: Run = {
        abort: new AbortController(),
        pending: Promise.resolve(),
      };
      run = current;
      starting = publish(current).then(
        () => {
          if (current.abort.signal.aborted)
            throw new TransportError("RELAY_FAILED", "轉發已停止");
        },
        (error: unknown) => {
          const failure = relayError(error, "無法開始轉發");
          if (run === current) {
            run = undefined;
            starting = undefined;
            closePeerConnection(current.pc);
            current.abort.abort();
            setState("error");
            emitError(failure);
          }
          throw failure;
        },
      );
      return starting;
    },
    stop,
    replaceTrack(kind, track) {
      if (destroyed) return;
      rememberTrack(kind, track);
      const current = run;
      if (!current?.senders) return;
      enqueue(current, () => applyMedia(current, kind)).catch(
        (error: unknown) => {
          if (run === current)
            emitError(relayError(error, "無法套用影音軌或編碼設定"));
        },
      );
    },
    async setQuality(next) {
      if (destroyed) throw new TransportError("RELAY_FAILED", "傳輸已銷毀");
      quality = next;
      const current = run;
      if (!current?.senders) return;
      try {
        await enqueue(current, () => applyMedia(current, "quality"));
      } catch (error) {
        const failure = relayError(error, "無法套用畫質");
        if (run === current) emitError(failure);
        throw failure;
      }
    },
    removePeer() {},
    onState: (handler) => events.on("state", handler),
    onPeerState: () => () => {},
    onStats: (handler) => events.on("stats", handler),
    onError: (handler) => events.on("error", handler),
    destroy() {
      if (destroyed) return;
      // 先停止事件，再停止傳輸；DELETE 照常在背景完成（§4）。
      destroyed = true;
      events.removeAll();
      stop();
    },
  };
};
