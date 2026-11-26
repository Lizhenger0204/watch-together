import type { ChatMessage } from "@project/shared";
import { DanmakuOverlay } from "./DanmakuOverlay";
import { DanmakuPanel } from "./DanmakuPanel";
import type { PlayerControlsProps } from "./PlayerControls";
import { useDanmakuFeed } from "./use-danmaku-feed";

/** 將房間聊天訊息直接轉成播放器所需的 danmaku 控制列設定與覆蓋層節點。 */
export function usePlayerDanmaku(
  messages: ChatMessage[],
  selfMemberId: string,
): {
  danmaku: NonNullable<PlayerControlsProps["danmaku"]>;
  danmakuOverlay: React.ReactNode;
} {
  const feed = useDanmakuFeed(messages, selfMemberId);
  return {
    danmaku: {
      on: feed.enabled,
      panel: (
        <DanmakuPanel
          enabled={feed.enabled}
          density={feed.density}
          onEnabledChange={feed.setEnabled}
          onDensityChange={feed.setDensity}
        />
      ),
    },
    danmakuOverlay: (
      <DanmakuOverlay
        items={feed.items}
        onDone={feed.removeItem}
        stageRef={feed.stageRef}
        probeRef={feed.probeRef}
      />
    ),
  };
}
