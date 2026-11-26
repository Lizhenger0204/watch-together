import type { MemberState } from "@project/shared";

// 收看端播放器的狀態提示（streaming.md §7）：等待房主開播、連線中、播放中、緩衝中、
// 連線失敗（提供「重新連線」）。

export type PlayerStatusInput = {
  live: boolean;
  state: MemberState;
  /** 連線失敗時顯示的原因（TransportError.message）。 */
  errorMessage: string | null;
  hostName: string | null;
  hostOnline: boolean;
  /** 房主是否仍在房間成員名單內（未提供時視為 true）。 */
  hostPresent?: boolean;
};

export type PlayerStatus = {
  /** null 代表正在播放，不蓋任何提示。 */
  text: string | null;
  tone: "info" | "error";
  /** 顯示「重新連線」按鈕。 */
  reconnect: boolean;
};

export function playerStatus(input: PlayerStatusInput): PlayerStatus {
  const host = input.hostName ?? "房主";
  if (!input.live) {
    if (input.hostPresent === false) {
      return {
        text: "房主已離開房間。",
        tone: "info",
        reconnect: false,
      };
    }
    return {
      text: input.hostOnline
        ? `等待 ${host} 開始播放…`
        : "房主目前離線，等待房主回來…",
      tone: "info",
      reconnect: false,
    };
  }
  switch (input.state) {
    case "playing":
      return { text: null, tone: "info", reconnect: false };
    case "buffering":
      return { text: "緩衝中…", tone: "info", reconnect: false };
    case "failed":
      return {
        text: input.errorMessage ?? "連線失敗。",
        tone: "error",
        reconnect: true,
      };
    default:
      return { text: "連線中…", tone: "info", reconnect: false };
  }
}
