import { Film, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PlayerControls,
  useFullscreen,
  usePlayerVolume,
  type PlayerControlsProps,
} from "../../components/player";
import { SOURCE_ACCEPT, type SourceCheckCode } from "./source-check";
import type { useLocalSource } from "./use-local-source";
import { SourceDiagnostics } from "./SourceDiagnostics";

const CHECK_MESSAGES: Record<SourceCheckCode, string> = {
  TIMEOUT: "影片載入或試播逾時，請重新選檔。",
  VIDEO_UNDECODABLE:
    "影像無法解碼。瀏覽器可能不支援此 HEVC 影片或容器，請試用 H.264 MP4。",
  NO_AUDIO: "音訊無法解碼或影片沒有音軌。要繼續播放無聲影片嗎？",
  CAPTURE_UNSUPPORTED: "此瀏覽器無法擷取影片，請使用桌面版 Chrome 或 Edge。",
  CAPTURE_FAILED:
    "無法擷取影片影像軌，請查看播放診斷，或更新桌面版 Chrome／Edge 後重新選檔。",
  PLAYBACK_FAILED:
    "影片試播失敗，請查看播放診斷，確認瀏覽器播放權限與原生解碼支援。",
};

export function HostSourcePlayer({
  source,
  belowTitle,
  belowAction,
  quality,
  danmaku,
  danmakuOverlay,
  theater,
}: {
  source: ReturnType<typeof useLocalSource>;
  /** 影片正下方的標題節點（未提供時使用片名，供獨立 demo 頁面使用）。 */
  belowTitle?: ReactNode;
  /** 影片正下方右側的主操作按鈕（例如開始／停止直播）。 */
  belowAction?: ReactNode;
  /** 控制列的畫質按鈕與面板（房間頁提供）。 */
  quality?: PlayerControlsProps["quality"];
  /** 控制列的彈幕開關與設定面板（房間頁提供）。 */
  danmaku?: PlayerControlsProps["danmaku"];
  /** 播放器容器內的彈幕層（隨全螢幕一起顯示）。 */
  danmakuOverlay?: ReactNode;
  /** 控制列的劇院模式按鈕（房間頁提供）。 */
  theater?: PlayerControlsProps["theater"];
}) {
  const { videoRef, check, selectFile, continueWithoutAudio, title } = source;
  const playerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const volume = usePlayerVolume();
  const fullscreen = useFullscreen(playerRef);
  const [controlError, setControlError] = useState("");
  const ready = check.status === "ready";

  // 房主本地音量直接調 video.volume，不影響擷取出去的音訊（streaming.md §1）。
  // 不用 video.muted：選檔檢查（probePlayback）會自己切換 muted。
  const { audible } = volume;
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = audible;
  }, [videoRef, audible]);

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

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    setControlError("");
    if (video.paused) {
      void video
        .play()
        .catch(() => setControlError("無法播放影片，請再試一次。"));
    } else {
      video.pause();
    }
  }

  return (
    <section className="grid min-w-0">
      <div
        ref={playerRef}
        className="group relative bg-black text-white fullscreen:grid fullscreen:place-items-center"
      >
        <video
          ref={videoRef}
          className="aspect-video max-h-[calc(100dvh-3rem)] w-full bg-black object-contain group-fullscreen:h-full group-fullscreen:max-h-none group-fullscreen:aspect-auto"
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
            className="absolute inset-x-0 top-0 bottom-16 grid place-items-center text-zinc-300 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none focus-visible:ring-inset"
          >
            <span className="grid justify-items-center gap-2 px-4 text-center">
              <Film className="size-8 text-zinc-400" strokeWidth={1.75} />
              <span className="text-sm font-medium">點擊選擇本機影片</span>
            </span>
          </button>
        )}
        {danmakuOverlay}
        <PlayerControls
          playback={{
            playing: ready && playing,
            disabled: !ready,
            onToggle: togglePlay,
          }}
          progress={{
            time,
            duration,
            disabled: !ready,
            onSeek: (next) => {
              const video = videoRef.current;
              if (!video) return;
              video.currentTime = next;
              setTime(video.currentTime);
            },
          }}
          volume={volume}
          quality={quality}
          danmaku={danmaku}
          theater={theater}
          fullscreen={{
            on: fullscreen.active,
            disabled: !ready || !fullscreen.supported,
            onToggle: () => {
              setControlError("");
              fullscreen.toggle(setControlError);
            },
          }}
        />
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
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-800 transition-colors focus-within:ring-2 focus-within:ring-[#0072b2] hover:bg-zinc-50">
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
          {(check.status === "ready" || check.status === "warning") && (
            <span
              data-testid="source-conversion"
              data-converted={String(check.converted)}
              data-frame-format={check.frameFormat ?? ""}
              className="mt-1.5 text-xs text-zinc-500"
            >
              {check.converted
                ? `10-bit 片源，送出前轉為 8-bit（${check.frameFormat ?? "opaque"}）`
                : check.frameFormat
                  ? `直接送出（${check.frameFormat}）`
                  : "直接送出"}
            </span>
          )}
          {check.status === "warning" && (
            <button
              type="button"
              className="mt-1.5 text-xs font-medium text-[#0072b2] underline-offset-2 hover:underline"
              onClick={continueWithoutAudio}
            >
              繼續播放無聲影片
            </button>
          )}
        </div>
        {check.status === "error" && check.diagnostic && (
          <SourceDiagnostics diagnostic={check.diagnostic} />
        )}
        {controlError && (
          <p role="alert" className="mt-1.5 text-xs text-red-600">
            {controlError}
          </p>
        )}
      </div>
    </section>
  );
}
