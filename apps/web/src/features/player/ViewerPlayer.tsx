import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ViewerSession } from "../room/viewer-session";
import { playerStatus } from "./player-status";

// 收看端播放器（streaming.md §7）：原生 <video srcObject>，只有音量與全螢幕。
// 自動播放政策會擋有聲音的播放，所以進房一律先顯示「點擊開始觀看」，點擊後才 play()；
// play() 被拒時恢復覆蓋層。

/** 有 track 且暫停中才 play()；被自動播放政策擋下時呼叫 onBlocked。 */
function playIfReady(video: HTMLVideoElement | null, onBlocked: () => void) {
  const stream = video?.srcObject;
  if (!video || !(stream instanceof MediaStream)) return;
  if (stream.getTracks().length === 0 || !video.paused) return;
  video.play().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      onBlocked();
    }
  });
}

/** iPhone Safari 不支援元素全螢幕，只能讓 <video> 自己進全螢幕。 */
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

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
  const frameRef = useRef<HTMLDivElement>(null);
  /** 使用者點過「開始觀看」（取得播放權限）。 */
  const [armed, setArmed] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const { remoteStream, state } = view;

  // remoteStream 在同一個傳輸內固定，換傳輸（停播重開、重連、切模式）才重新綁定。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = remoteStream;
    viewer.setBuffering(false);
  }, [remoteStream, viewer]);

  // 傳輸用 addTrack 加入 track 不會觸發 MediaStream 的 addtrack 事件，
  // 所以在連線狀態變化時（例如變成 playing）補一次 play()。
  useEffect(() => {
    if (armed) playIfReady(videoRef.current, () => setArmed(false));
  }, [armed, remoteStream, state]);

  const status = playerStatus({
    live: view.live,
    state,
    errorMessage: view.error?.message ?? null,
    hostName,
    hostOnline,
  });

  return (
    <div className="grid gap-2">
      <div
        ref={frameRef}
        className="relative grid aspect-video grid-cols-[minmax(0,1fr)] overflow-hidden rounded-2xl bg-black fullscreen:rounded-none"
        data-testid="viewer-stage"
      >
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          autoPlay
          playsInline
          onWaiting={() => viewer.setBuffering(true)}
          onStalled={() => viewer.setBuffering(true)}
          onPlaying={() => viewer.setBuffering(false)}
        />
        {!armed ? (
          <button
            type="button"
            className="absolute inset-0 grid place-items-center bg-black/60 text-white transition-colors hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none focus-visible:ring-inset"
            onClick={() => {
              setArmed(true);
              playIfReady(videoRef.current, () => setArmed(false));
            }}
          >
            <span className="grid justify-items-center gap-2 px-4 text-center">
              <span className="grid size-16 place-items-center rounded-full bg-violet-600 text-2xl">
                ▶
              </span>
              <span className="text-base font-medium">點擊開始觀看</span>
              {status.text && (
                <span className="text-sm wrap-anywhere text-zinc-300">
                  {status.text}
                </span>
              )}
            </span>
          </button>
        ) : (
          status.text && (
            <div
              role={status.tone === "error" ? "alert" : "status"}
              className={`absolute inset-0 grid place-items-center px-4 text-center ${
                state === "buffering" ? "pointer-events-none" : "bg-black/70"
              }`}
            >
              <div className="grid justify-items-center gap-3">
                <p
                  className={`wrap-anywhere ${
                    status.tone === "error" ? "text-rose-200" : "text-zinc-300"
                  } ${state === "buffering" ? "rounded-lg bg-black/60 px-3 py-1.5" : ""}`}
                >
                  {status.text}
                </p>
                {status.reconnect && (
                  <button
                    type="button"
                    className="inline-flex min-h-10 items-center rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-500 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none"
                    onClick={() => viewer.reconnect()}
                  >
                    重新連線
                  </button>
                )}
              </div>
            </div>
          )
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
        <button
          type="button"
          className="rounded-lg px-2 py-1 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none"
          aria-pressed={muted}
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            video.muted = !video.muted;
            setMuted(video.muted);
          }}
        >
          {muted ? "取消靜音" : "靜音"}
        </button>
        <label className="flex items-center gap-2">
          音量
          <input
            type="range"
            className="w-28"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => {
              const video = videoRef.current;
              if (!video) return;
              video.volume = event.currentTarget.valueAsNumber;
              setVolume(video.volume);
            }}
          />
        </label>
        <button
          type="button"
          className="ml-auto rounded-lg px-2 py-1 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none"
          onClick={() => {
            const frame = frameRef.current;
            if (!frame) return;
            setFullscreenError("");
            if (!document.fullscreenEnabled) {
              const video = videoRef.current as IosVideo | null;
              if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
              else setFullscreenError("這個瀏覽器不支援全螢幕。");
              return;
            }
            const action =
              document.fullscreenElement === frame
                ? document.exitFullscreen()
                : frame.requestFullscreen();
            void action.catch(() => setFullscreenError("無法切換全螢幕。"));
          }}
        >
          全螢幕
        </button>
      </div>
      {fullscreenError && (
        <p role="alert" className="text-sm text-rose-200">
          {fullscreenError}
        </p>
      )}
    </div>
  );
}
