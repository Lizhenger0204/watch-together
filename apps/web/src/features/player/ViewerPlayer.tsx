import { Play } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  PlayerControls,
  useFullscreen,
  usePlayerVolume,
} from "../../components/player";
import type { ViewerSession } from "../room/viewer-session";
import { watchPlaybackProgress } from "./playback-progress";
import { playerStatus } from "./player-status";

// 收看端播放器（streaming.md §7）：原生 <video srcObject>，只有音量與全螢幕。
// 自動播放政策會擋有聲音的播放，所以進房一律先顯示「點擊開始觀看」，點擊後才 play()；
// play() 被拒時恢復覆蓋層。<video> 不可加 autoPlay：從邀請頁按「加入」後，Chrome 已把那次
// 點擊算成使用者手勢，autoPlay 會在覆蓋層還在時就播出聲音。

/** 有 track 且暫停中才 play()；播放失敗時呼叫 onBlocked（恢復覆蓋層讓使用者重試）。 */
function playIfReady(video: HTMLMediaElement | null, onBlocked: () => void) {
  const stream = video?.srcObject;
  if (!video || !(stream instanceof MediaStream)) return;
  if (stream.getTracks().length === 0 || !video.paused) return;
  video.play().catch((error: unknown) => {
    // 換 srcObject 會中斷前一次 play()（AbortError），新的 stream 會再呼叫一次，不用處理。
    if (
      video.srcObject !== stream ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      return;
    onBlocked();
  });
}

export function ViewerPlayer({
  viewer,
  hostName,
  hostOnline,
}: {
  viewer: ViewerSession;
  hostName: string | null;
  hostOnline: boolean;
}) {
  const view = useSyncExternalStore(viewer.subscribe, viewer.getView);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioFallbackStream, setAudioFallbackStream] =
    useState<MediaStream | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  /** 使用者點過「開始觀看」（取得播放權限）。 */
  const [armed, setArmed] = useState(false);
  const volume = usePlayerVolume();
  const fullscreen = useFullscreen(frameRef, videoRef);
  const [fullscreenError, setFullscreenError] = useState("");
  const { remoteStream, state } = view;

  // 靜音用 muted 屬性（見下方 JSX），音量另外套到 <video> 與備援 <audio>。
  const level = volume.volume;
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = level;
    if (audioRef.current) audioRef.current.volume = level;
  }, [level]);

  // 空的 MediaStream 先綁進 Chrome，後來只加音軌時，播放器可能會一直等 metadata。
  const connected = state === "playing" || state === "buffering";
  const playableStream =
    remoteStream && (connected || remoteStream.getTracks().length > 0)
      ? remoteStream
      : null;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playableStream) return;
    video.srcObject = playableStream;
    return () => {
      video.srcObject = null;
      setAudioFallbackStream(null);
    };
  }, [playableStream]);

  const watching = armed && connected;
  const playingAudioOnly =
    connected && !!remoteStream && audioFallbackStream === remoteStream;
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!watching || !video || !audio || !remoteStream) return;
    return watchPlaybackProgress(
      video,
      remoteStream,
      viewer.getReceiveBitrate,
      (stalled) => viewer.setBuffering(stalled, remoteStream),
      {
        element: audio,
        start: () => setAudioFallbackStream(remoteStream),
      },
    );
  }, [watching, remoteStream, viewer]);

  // 房主的空 video transceiver 也會產生 receiver track。Chrome 等第一格時，
  // 用純音軌播放；原 video 保留完整 stream，一有影像便能接手。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playingAudioOnly || !remoteStream) return;
    audio.srcObject = new MediaStream(remoteStream.getAudioTracks());
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  }, [playingAudioOnly, remoteStream]);

  // 傳輸用 addTrack 加入 track 不會觸發 MediaStream 的 addtrack 事件，
  // 所以在連線狀態變化時（例如變成 playing）補一次 play()。
  useEffect(() => {
    if (!armed) return;
    playIfReady(videoRef.current, () => setArmed(false));
    playIfReady(audioRef.current, () => setArmed(false));
  }, [armed, remoteStream, state, playingAudioOnly]);

  const status = playerStatus({
    live: view.live,
    state,
    errorMessage: view.error?.message ?? null,
    hostName,
    hostOnline,
  });

  return (
    <div className="grid min-w-0">
      <div
        ref={frameRef}
        className="relative grid aspect-video grid-cols-[minmax(0,1fr)] overflow-hidden bg-black text-white"
        data-testid="viewer-stage"
      >
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          playsInline
          muted={volume.muted || playingAudioOnly}
          onResize={(event) => {
            if (event.currentTarget.videoWidth > 0)
              setAudioFallbackStream(null);
          }}
        />
        <audio ref={audioRef} hidden muted={volume.muted} />
        {/* 連線失敗時直接給「重新連線」，即使還沒按過開始觀看（按鈕本身就是使用者手勢）。 */}
        {!armed && !status.reconnect ? (
          <button
            type="button"
            className="absolute inset-0 z-10 grid place-items-center bg-black/50 text-white transition-colors hover:bg-black/40 focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none focus-visible:ring-inset"
            onClick={() => {
              setArmed(true);
              playIfReady(videoRef.current, () => setArmed(false));
              playIfReady(audioRef.current, () => setArmed(false));
            }}
          >
            <span className="grid justify-items-center gap-2 px-4 text-center">
              <span className="grid size-14 place-items-center rounded-full bg-zinc-600/75 text-white">
                <Play
                  className="ml-0.5 size-6 fill-current"
                  strokeWidth={1.75}
                />
              </span>
              <span className="text-sm font-medium">點擊開始觀看</span>
              {status.text && (
                <span className="text-xs wrap-anywhere text-zinc-200">
                  {status.text}
                </span>
              )}
            </span>
          </button>
        ) : (
          status.text && (
            <div
              role={status.tone === "error" ? "alert" : "status"}
              className={`absolute inset-0 z-10 grid place-items-center px-4 text-center ${
                state === "buffering" ? "pointer-events-none" : "bg-black/65"
              }`}
            >
              <div className="grid justify-items-center gap-3">
                <p
                  className={`text-sm wrap-anywhere ${
                    status.tone === "error" ? "text-red-200" : "text-zinc-200"
                  } ${state === "buffering" ? "rounded-sm bg-black/70 px-3 py-1.5" : ""}`}
                >
                  {status.text}
                </p>
                {status.reconnect && (
                  <button
                    type="button"
                    className="inline-flex min-h-9 items-center rounded bg-[#0072b2] px-4 text-sm font-medium text-white hover:bg-[#005a8d] focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none"
                    onClick={() => {
                      setArmed(true);
                      viewer.reconnect();
                    }}
                  >
                    重新連線
                  </button>
                )}
              </div>
            </div>
          )
        )}

        {/* 收看端只有音量與全螢幕（streaming.md §7），控制列放在全螢幕容器內。 */}
        <PlayerControls
          volume={volume}
          fullscreen={{
            on: fullscreen.active,
            disabled: !fullscreen.supported,
            onToggle: () => {
              setFullscreenError("");
              fullscreen.toggle(setFullscreenError);
            },
          }}
        />
      </div>
      {fullscreenError && (
        <p role="alert" className="px-4 pt-2 text-xs text-red-600">
          {fullscreenError}
        </p>
      )}
    </div>
  );
}
