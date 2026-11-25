import { useEffect, useState, type RefObject } from "react";

/** iPhone Safari 不支援元素全螢幕，只能讓 <video> 自己進全螢幕。 */
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/**
 * 播放器容器的全螢幕狀態與切換（DESIGN.md §3：全螢幕對象是播放器容器，
 * 控制列與之後的彈幕層一起進全螢幕）。
 * `fallbackVideo`：瀏覽器不支援元素全螢幕時（iPhone Safari）改用 <video> 原生全螢幕。
 */
export function useFullscreen(
  target: RefObject<HTMLElement | null>,
  fallbackVideo?: RefObject<HTMLVideoElement | null>,
) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onChange = () => {
      setActive(
        document.fullscreenElement !== null &&
          document.fullscreenElement === target.current,
      );
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [target]);

  const supported =
    typeof document !== "undefined" &&
    (document.fullscreenEnabled || fallbackVideo !== undefined);

  /** 切換全螢幕；失敗時以 onError 回報要顯示的文字。 */
  function toggle(onError: (message: string) => void) {
    const element = target.current;
    if (!element) return;
    if (!document.fullscreenEnabled) {
      const video = fallbackVideo?.current as IosVideo | null | undefined;
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else onError("這個瀏覽器不支援全螢幕。");
      return;
    }
    const action =
      document.fullscreenElement === element
        ? document.exitFullscreen()
        : element.requestFullscreen();
    void action.catch(() => onError("無法切換全螢幕。"));
  }

  return { active, supported, toggle };
}
