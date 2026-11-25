import {
  Maximize,
  MessageSquareOff,
  MessageSquareText,
  MessagesSquare,
  Minimize,
  Pause,
  Play,
  RectangleHorizontal,
  Volume1,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { formatTime } from "./format-time";
import type { PlayerVolume } from "./use-player-volume";

// 房主與收看端共用的圖示控制列（T-125，DESIGN.md §2、§5）。
// 每一組控制都是選填：沒傳就不顯示（收看端沒有播放／進度／畫質／劇院模式）。
// 控制列放在播放器容器內，全螢幕時一起顯示。

const ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center text-white/90 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

function IconButton({
  icon: Icon,
  label,
  pressed,
  disabled,
  filled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  filled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={ICON_BUTTON}
      onClick={onClick}
    >
      <Icon
        className={`size-[18px] ${filled ? "fill-current" : ""}`}
        strokeWidth={1.75}
      />
    </button>
  );
}

/** 控制列上方彈出的面板（畫質）。點外面或按 Esc 關閉。 */
function PopoverButton({
  label,
  title,
  disabled,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={`${title}：${label}`}
        title={title}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        className={`${ICON_BUTTON} w-auto px-1.5 text-xs font-semibold tabular-nums`}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={title}
          className="absolute right-0 bottom-full z-30 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-sm bg-zinc-900/95 p-3 text-left text-white shadow-sm"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export type PlayerControlsProps = {
  /** 房主：播放／暫停。 */
  playback?: { playing: boolean; disabled?: boolean; onToggle: () => void };
  /** 房主：進度條與時間。 */
  progress?: {
    time: number;
    duration: number;
    disabled?: boolean;
    onSeek: (time: number) => void;
  };
  volume: PlayerVolume;
  /** 房主：畫質按鈕（顯示目前畫質，點開後是 panel）。 */
  quality?: { label: string; disabled?: boolean; panel: ReactNode };
  /** 彈幕開關（T-127 接上）。 */
  danmaku?: { on: boolean; onToggle: () => void };
  /** 收看端聊天入口（T-127 接上）。 */
  chat?: { open: boolean; onToggle: () => void };
  /** 房主：劇院模式（隱藏側欄讓影片滿寬）。 */
  theater?: { on: boolean; onToggle: () => void };
  fullscreen: { on: boolean; disabled?: boolean; onToggle: () => void };
};

export function PlayerControls({
  playback,
  progress,
  volume,
  quality,
  danmaku,
  chat,
  theater,
  fullscreen,
}: PlayerControlsProps) {
  const VolumeIcon =
    volume.audible === 0 ? VolumeX : volume.audible < 0.5 ? Volume1 : Volume2;
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pt-5 pb-1.5">
      {progress && (
        <input
          type="range"
          aria-label="影片進度"
          className="player-range mb-1.5 block w-full"
          min={0}
          max={progress.duration || 1}
          step={0.01}
          value={progress.disabled ? 0 : progress.time}
          disabled={progress.disabled || progress.duration === 0}
          onChange={(event) =>
            progress.onSeek(event.currentTarget.valueAsNumber)
          }
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {playback && (
            <IconButton
              icon={playback.playing ? Pause : Play}
              label={playback.playing ? "暫停" : "播放"}
              filled
              disabled={playback.disabled}
              onClick={playback.onToggle}
            />
          )}
          {progress && (
            <span className="px-1 font-mono text-xs whitespace-nowrap text-white/90 tabular-nums">
              {formatTime(progress.disabled ? 0 : progress.time)} /{" "}
              {formatTime(progress.duration)}
            </span>
          )}
          <div className="flex items-center gap-1">
            <IconButton
              icon={VolumeIcon}
              label={volume.audible === 0 ? "取消靜音" : "靜音"}
              pressed={volume.muted}
              onClick={volume.toggleMute}
            />
            <input
              type="range"
              aria-label="音量"
              className="player-range w-16 sm:w-20"
              min={0}
              max={1}
              step={0.01}
              value={volume.audible}
              onChange={(event) =>
                volume.setVolume(event.currentTarget.valueAsNumber)
              }
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {quality && (
            <PopoverButton
              label={quality.label}
              title="畫質"
              disabled={quality.disabled}
            >
              {quality.panel}
            </PopoverButton>
          )}
          {danmaku && (
            <IconButton
              icon={danmaku.on ? MessageSquareText : MessageSquareOff}
              label={danmaku.on ? "關閉彈幕" : "開啟彈幕"}
              pressed={danmaku.on}
              onClick={danmaku.onToggle}
            />
          )}
          {chat && (
            <IconButton
              icon={MessagesSquare}
              label={chat.open ? "收起聊天室" : "開啟聊天室"}
              pressed={chat.open}
              onClick={chat.onToggle}
            />
          )}
          {theater && (
            <span className="hidden lg:contents">
              <IconButton
                icon={RectangleHorizontal}
                label={theater.on ? "退出劇院模式" : "劇院模式"}
                pressed={theater.on}
                onClick={theater.onToggle}
              />
            </span>
          )}
          <IconButton
            icon={fullscreen.on ? Minimize : Maximize}
            label={fullscreen.on ? "退出全螢幕" : "全螢幕"}
            disabled={fullscreen.disabled}
            onClick={fullscreen.onToggle}
          />
        </div>
      </div>
    </div>
  );
}
