import {
  AlertTriangle,
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

type PopoverKind = "quality" | "danmaku";

/**
 * 控制列上方彈出面板（畫質、彈幕設定）的開關與焦點管理。
 * 面板定位在播放器容器內（不是跟著按鈕），所以窄視窗不會被左緣裁掉；
 * 同一時間最多只開啟一個面板。點外面或按 Esc 關閉；從面板內按 Esc 要把焦點還給對應按鈕。
 */
function useControlsPopover(qualityDisabled: boolean | undefined) {
  const [open, setOpen] = useState<PopoverKind | null>(null);
  const qualityButtonRef = useRef<HTMLButtonElement>(null);
  const danmakuButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const triggerRef = open === "quality" ? qualityButtonRef : danmakuButtonRef;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !qualityButtonRef.current?.contains(target) &&
        !danmakuButtonRef.current?.contains(target)
      ) {
        setOpen(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      const hadFocus =
        active === document.body ||
        panelRef.current?.contains(active) ||
        triggerRef.current === active;
      setOpen(null);
      if (hadFocus) triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 鍵盤使用者開啟後，Tab 先進面板而不是跳到控制列的下一顆按鈕。
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (qualityDisabled && open === "quality") setOpen(null);
  }, [qualityDisabled, open]);

  function toggle(kind: PopoverKind) {
    setOpen((prev) => (prev === kind ? null : kind));
  }

  return { open, toggle, qualityButtonRef, danmakuButtonRef, panelRef };
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
  /** 房主：畫質按鈕（顯示目前畫質，點開後是 panel）；warning 為即時編碼警告。 */
  quality?: {
    label: string;
    disabled?: boolean;
    warning?: string;
    panel: ReactNode;
  };
  /** 彈幕設定（有 panel 時點開顯示開關與密度；無 panel 時直接切換）。 */
  danmaku?: { on: boolean; panel?: ReactNode; onToggle?: () => void };
  /** 收看端聊天室入口。 */
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
  const popover = useControlsPopover(quality?.disabled);
  const suppressStageClickRef = useRef(false);
  const qualityPanelId = useId();
  const danmakuPanelId = useId();

  const activeDialog =
    popover.open === "quality" && quality
      ? {
          id: qualityPanelId,
          label: "畫質",
          widthClass: "w-80",
          content: quality.panel,
        }
      : popover.open === "danmaku" && danmaku?.panel
        ? {
            id: danmakuPanelId,
            label: "彈幕設定",
            widthClass: "w-56",
            content: danmaku.panel,
          }
        : null;

  return (
    // 外層蓋滿播放器；控制列以上區域在有啟用播放控制時可點擊切換播放／暫停，
    // 彈出面板疊在點擊層上方且高度限制在控制列以上空間內捲動。
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col justify-end">
        {playback && !playback.disabled && (
          <div
            aria-hidden
            data-testid="player-stage-toggle"
            className="pointer-events-auto absolute inset-0 cursor-pointer"
            onPointerDown={() => {
              // 畫質／彈幕面板展開時，點影片區只用來關面板（document pointerdown），不順便切換播放。
              suppressStageClickRef.current = popover.open !== null;
            }}
            onClick={() => {
              if (suppressStageClickRef.current) {
                suppressStageClickRef.current = false;
                return;
              }
              if (popover.open !== null) return;
              playback.onToggle();
            }}
          />
        )}
        {activeDialog && (
          <div
            ref={popover.panelRef}
            id={activeDialog.id}
            role="dialog"
            aria-label={activeDialog.label}
            tabIndex={-1}
            className={`pointer-events-auto relative z-10 mx-3 mb-1 min-h-0 max-w-[calc(100%-1.5rem)] self-end overflow-y-auto overscroll-contain rounded-sm bg-zinc-900/95 p-3 text-left text-white shadow-sm focus-visible:outline-none ${activeDialog.widthClass}`}
          >
            {activeDialog.content}
          </div>
        )}
        {!activeDialog && quality?.warning && (
          <div
            role="status"
            className="pointer-events-auto relative z-10 mx-3 mb-1 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 self-end rounded-sm border border-amber-400/50 bg-zinc-900/95 px-2.5 py-1.5 text-xs text-amber-200"
          >
            <AlertTriangle
              className="size-3.5 shrink-0 text-amber-400"
              strokeWidth={1.75}
            />
            <span>{quality.warning}</span>
          </div>
        )}
      </div>
      <div className="pointer-events-auto shrink-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pt-5 pb-1.5">
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
            {quality?.warning && (
              <button
                type="button"
                aria-label={quality.warning}
                title={quality.warning}
                disabled={quality.disabled}
                className={`${ICON_BUTTON} text-amber-400 hover:text-amber-300`}
                onClick={() => popover.toggle("quality")}
              >
                <AlertTriangle className="size-4" strokeWidth={1.75} />
              </button>
            )}
            {quality && (
              <button
                ref={popover.qualityButtonRef}
                type="button"
                aria-label={`畫質：${quality.label}`}
                title="畫質"
                aria-haspopup="dialog"
                aria-expanded={popover.open === "quality"}
                aria-controls={
                  popover.open === "quality" ? qualityPanelId : undefined
                }
                disabled={quality.disabled}
                className={`${ICON_BUTTON} w-auto px-1.5 text-xs font-semibold tabular-nums`}
                onClick={() => popover.toggle("quality")}
              >
                {quality.label}
              </button>
            )}
            {danmaku &&
              (danmaku.panel ? (
                <button
                  ref={popover.danmakuButtonRef}
                  type="button"
                  aria-label={
                    danmaku.on ? "彈幕設定（已開啟）" : "彈幕設定（已關閉）"
                  }
                  title="彈幕設定"
                  aria-haspopup="dialog"
                  aria-expanded={popover.open === "danmaku"}
                  aria-controls={
                    popover.open === "danmaku" ? danmakuPanelId : undefined
                  }
                  className={ICON_BUTTON}
                  onClick={() => popover.toggle("danmaku")}
                >
                  {danmaku.on ? (
                    <MessageSquareText
                      className="size-[18px]"
                      strokeWidth={1.75}
                    />
                  ) : (
                    <MessageSquareOff
                      className="size-[18px] text-white/60"
                      strokeWidth={1.75}
                    />
                  )}
                </button>
              ) : (
                <IconButton
                  icon={danmaku.on ? MessageSquareText : MessageSquareOff}
                  label={danmaku.on ? "關閉彈幕" : "開啟彈幕"}
                  pressed={danmaku.on}
                  onClick={() => danmaku.onToggle?.()}
                />
              ))}
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
    </div>
  );
}
