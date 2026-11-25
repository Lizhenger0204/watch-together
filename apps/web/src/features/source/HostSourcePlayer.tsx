import {
  Film,
  FolderOpen,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SOURCE_ACCEPT, type SourceCheckCode } from "./source-check";
import type { useLocalSource } from "./use-local-source";

const CHECK_MESSAGES: Record<SourceCheckCode, string> = {
  TIMEOUT: "影片載入或試播逾時，請重新選檔。",
  VIDEO_UNDECODABLE:
    "影像無法解碼。瀏覽器可能不支援此 HEVC 影片或容器，請試用 H.264 MP4。",
  NO_AUDIO: "音訊無法解碼或影片沒有音軌。要繼續播放無聲影片嗎？",
  CAPTURE_UNSUPPORTED: "此瀏覽器無法擷取影片，請使用桌面版 Chrome 或 Edge。",
};

function formatTime(value: number) {
  const seconds = Math.floor(value);
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts
    .map((part, index) => String(part).padStart(index === 0 ? 1 : 2, "0"))
    .join(":");
}

export function HostSourcePlayer({
  source,
  belowTitle,
  belowAction,
}: {
  source: ReturnType<typeof useLocalSource>;
  /** 影片正下方的標題節點（未提供時使用片名，供獨立 demo 頁面使用）。 */
  belowTitle?: ReactNode;
  /** 影片正下方右側的主操作按鈕（例如開始／停止直播）。 */
  belowAction?: ReactNode;
}) {
  const { videoRef, check, selectFile, continueWithoutAudio, title } = source;
  const playerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastVolumeRef = useRef(1);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlError, setControlError] = useState("");
  const ready = check.status === "ready";

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === playerRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const statusText =
    check.status === "checking"
      ? "正在檢查影片…"
      : check.status === "ready"
        ? check.code === "NO_AUDIO"
          ? "可以播放（無聲）"
          : "檢查通過，可以播放。"
        : check.status === "error" || check.status === "warning"
          ? CHECK_MESSAGES[check.code]
          : "";

  const statusColor =
    check.status === "error"
      ? "text-red-600"
      : check.status === "warning"
        ? "text-amber-700"
        : "text-zinc-500";

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    if (volume > 0) {
      lastVolumeRef.current = volume;
      video.volume = 0;
      setVolume(0);
    } else {
      const restored = lastVolumeRef.current > 0 ? lastVolumeRef.current : 1;
      video.volume = restored;
      setVolume(restored);
    }
  }

  return (
    <section className="grid min-w-0">
      <div
        ref={playerRef}
        className="group relative bg-black text-white fullscreen:flex fullscreen:flex-col"
      >
        <video
          ref={videoRef}
          className="aspect-video w-full bg-black object-contain group-fullscreen:min-h-0 group-fullscreen:flex-1"
          playsInline
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onDurationChange={(event) => {
            const value = event.currentTarget.duration;
            setDuration(Number.isFinite(value) ? value : 0);
          }}
          onEmptied={() => {
            setDuration(0);
            setTime(0);
            setPlaying(false);
          }}
        />
        {check.status === "idle" && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="absolute inset-x-0 top-0 bottom-12 grid place-items-center text-zinc-300 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-[#0095d9] focus-visible:outline-none focus-visible:ring-inset"
          >
            <span className="grid justify-items-center gap-2 px-4 text-center">
              <Film className="size-8 text-zinc-400" strokeWidth={1.5} />
              <span className="text-sm font-medium">點擊選擇本機影片</span>
            </span>
          </button>
        )}
        <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pt-4 pb-2 group-fullscreen:static group-fullscreen:bg-black/90 group-fullscreen:pt-2">
          <input
            type="range"
            aria-label="影片進度"
            className="player-range mb-2 block w-full"
            min={0}
            max={duration || 1}
            step={0.01}
            value={ready ? time : 0}
            disabled={!ready || duration === 0}
            onChange={(event) => {
              const video = videoRef.current;
              if (!video) return;
              video.currentTime = event.currentTarget.valueAsNumber;
              setTime(video.currentTime);
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                aria-label={ready && playing ? "暫停" : "播放"}
                title={ready && playing ? "暫停" : "播放"}
                className="inline-flex size-7 items-center justify-center text-white/90 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-[#0095d9] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!ready}
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  setControlError("");
                  if (video.paused) {
                    void video
                      .play()
                      .catch(() =>
                        setControlError("無法播放影片，請再試一次。"),
                      );
                  } else {
                    video.pause();
                  }
                }}
              >
                {ready && playing ? (
                  <Pause className="size-4 fill-current" strokeWidth={1.75} />
                ) : (
                  <Play className="size-4 fill-current" strokeWidth={1.75} />
                )}
              </button>
              <span className="font-mono text-xs text-white/90 tabular-nums">
                {formatTime(ready ? time : 0)} / {formatTime(duration)}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={volume === 0 ? "取消靜音" : "靜音"}
                  title={volume === 0 ? "取消靜音" : "靜音"}
                  className="inline-flex size-7 items-center justify-center text-white/90 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-[#0095d9] focus-visible:outline-none"
                  onClick={toggleMute}
                >
                  {volume === 0 ? (
                    <VolumeX className="size-4" strokeWidth={1.75} />
                  ) : (
                    <Volume2 className="size-4" strokeWidth={1.75} />
                  )}
                </button>
                <input
                  aria-label="本地音量"
                  className="player-range w-16 sm:w-20"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(event) => {
                    const video = videoRef.current;
                    if (!video) return;
                    const next = event.currentTarget.valueAsNumber;
                    if (next > 0) lastVolumeRef.current = next;
                    video.volume = next;
                    setVolume(video.volume);
                  }}
                />
              </div>
            </div>
            <button
              type="button"
              aria-label={isFullscreen ? "退出全螢幕" : "全螢幕"}
              title={isFullscreen ? "退出全螢幕" : "全螢幕"}
              className="inline-flex size-7 items-center justify-center text-white/90 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-[#0095d9] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!ready || !document.fullscreenEnabled}
              onClick={() => {
                const player = playerRef.current;
                if (!player) return;
                const action =
                  document.fullscreenElement === player
                    ? document.exitFullscreen()
                    : player.requestFullscreen();
                void action.catch(() => setControlError("無法切換全螢幕。"));
              }}
            >
              {isFullscreen ? (
                <Minimize className="size-4" strokeWidth={1.75} />
              ) : (
                <Maximize className="size-4" strokeWidth={1.75} />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 影片正下方的片名與操作橫列（對齊 DESIGN.md §3） */}
      <div className="border-b border-zinc-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {belowTitle ??
              (title ? (
                <h2 className="text-base font-semibold wrap-anywhere text-zinc-900">
                  {title}
                </h2>
              ) : (
                <span className="text-sm text-zinc-500">尚未選擇影片</span>
              ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-800 transition-colors focus-within:ring-2 focus-within:ring-[#0095d9] hover:bg-zinc-50">
              <FolderOpen className="size-4 text-zinc-500" strokeWidth={1.75} />
              選擇影片
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                accept={SOURCE_ACCEPT}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  setControlError("");
                  void selectFile(file);
                }}
              />
            </label>
            {belowAction}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div
            role="status"
            className={`mt-1.5 text-xs empty:mt-0 ${statusColor}`}
          >
            {statusText}
          </div>
          {check.status === "warning" && (
            <button
              type="button"
              className="mt-1.5 text-xs font-medium text-[#0095d9] underline-offset-2 hover:underline"
              onClick={continueWithoutAudio}
            >
              繼續播放無聲影片
            </button>
          )}
        </div>
        {controlError && (
          <p role="alert" className="mt-1.5 text-xs text-red-600">
            {controlError}
          </p>
        )}
      </div>
    </section>
  );
}
