import { TITLE_MAX_LENGTH, type StreamInfo } from "@project/shared";

// 房主端的「開播意圖」：房主按開始直播就成立，按停止才清除。
// 伺服器在房主每次重新驗證時會把直播改成未開播（protocol.md「房主重新連線」），
// 換片檢查期間片源也暫時不可用；房主端依意圖與片源狀態算出該送的 stream:status。

export type StreamCommand = { live: boolean; title: string | null };

export type StreamCommandInput = {
  intent: boolean;
  /** 已收到 room:snapshot（驗證成功）。 */
  connected: boolean;
  /** 第幾次 room:snapshot；每次重新驗證都是新的直播工作階段。 */
  session: number;
  stream: StreamInfo;
  source: { ready: boolean; title: string };
  lastSent: { session: number; command: StreamCommand } | null;
};

/** 片名送出前截到 TITLE_MAX_LENGTH（UTF-16 長度），不切斷 emoji。 */
export function streamTitle(raw: string): string | null {
  let title = "";
  for (const char of raw.trim()) {
    if (title.length + char.length > TITLE_MAX_LENGTH) break;
    title += char;
  }
  return title || null;
}

function desired(input: StreamCommandInput): StreamCommand {
  const { intent, source } = input;
  return intent && source.ready
    ? { live: true, title: streamTitle(source.title) }
    : { live: false, title: null };
}

const same = (a: StreamCommand, b: StreamCommand) =>
  a.live === b.live && (!a.live || a.title === b.title);

/** 回傳現在該送的 stream:status；不需要送就回 null。 */
export function nextStreamCommand(
  input: StreamCommandInput,
): StreamCommand | null {
  if (!input.connected) return null;
  const want = desired(input);
  if (same(want, input.stream)) return null;
  const { lastSent } = input;
  // 同一個工作階段已經送過同樣的請求，等伺服器廣播或 ack 失敗就好，不要重送。
  if (lastSent?.session === input.session && same(want, lastSent.command)) {
    return null;
  }
  return want;
}

export type SentCommand = { session: number; command: StreamCommand };

/**
 * stream:status 被伺服器拒絕（ack 失敗）後的處理。
 * - 忘掉這筆已送出的紀錄，否則 nextStreamCommand 會當成「已經送過」，手動重試也不會再送。
 * - 開播失敗時一併取消開播意圖：按鈕回到「開始直播」，由房主看完錯誤後手動重試，
 *   不在背景自動重送（伺服器持續拒絕時會一直失敗）。
 * 失敗的若是較舊的請求（之後又送了新的），不動目前的紀錄與意圖。
 */
export function afterStreamCommandFailed(
  lastSent: SentCommand | null,
  failed: SentCommand,
): { lastSent: SentCommand | null; cancelIntent: boolean } {
  if (lastSent !== failed) return { lastSent, cancelIntent: false };
  return { lastSent: null, cancelIntent: failed.command.live };
}
