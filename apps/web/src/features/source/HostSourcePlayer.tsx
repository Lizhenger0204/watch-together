import { useRef, useState } from "react";
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
}: {
  source: ReturnType<typeof useLocalSource>;
}) {
  const { videoRef, check, selectFile, continueWithoutAudio, title } = source;
  const playerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [controlError, setControlError] = useState("");
  const ready = check.status === "ready";

  return (
    <section className="grid max-w-3xl gap-3">
      <label className="w-fit cursor-pointer rounded border px-3 py-1.5 focus-within:ring-2">
        選擇影片
        <input
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
      {title && <h2 className="font-medium break-all">{title}</h2>}
      <div role="status">
        {check.status === "checking" && "正在檢查影片…"}
        {check.status === "ready" &&
          (check.code === "NO_AUDIO"
            ? "可以播放（無聲）"
            : "檢查通過，可以播放。")}
        {(check.status === "error" || check.status === "warning") &&
          CHECK_MESSAGES[check.code]}
      </div>
      {check.status === "warning" && (
        <button
          type="button"
          className="justify-self-start underline"
          onClick={continueWithoutAudio}
        >
          繼續播放無聲影片
        </button>
      )}
      <div
        ref={playerRef}
        className="group bg-neutral-950 text-white fullscreen:flex fullscreen:flex-col"
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
        <div className="flex flex-wrap items-center gap-3 p-3">
          <button
            type="button"
            className="disabled:opacity-50"
            disabled={!ready}
            onClick={() => {
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
            }}
          >
            {ready && playing ? "暫停" : "播放"}
          </button>
          <input
            type="range"
            aria-label="影片進度"
            className="min-w-20 flex-1"
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
          <span className="tabular-nums">
            {formatTime(ready ? time : 0)} / {formatTime(duration)}
          </span>
          <label className="flex items-center gap-2">
            本地音量
            <input
              className="w-20"
              type="range"
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
            className="disabled:opacity-50"
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
            全螢幕
          </button>
        </div>
      </div>
      {controlError && <p role="alert">{controlError}</p>}
    </section>
  );
}
