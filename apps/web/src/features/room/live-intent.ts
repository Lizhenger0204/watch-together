import { TITLE_MAX_LENGTH } from "@project/shared";

// 房主端的「開播意圖」：房主按開始直播就成立，按停止才清除（存在分頁的 sessionStorage）。
// 依意圖、片源與伺服器狀態送 stream:status 的邏輯在 host-session.ts。

/** 片名送出前截到 TITLE_MAX_LENGTH（UTF-16 長度），不切斷 emoji。 */
export function streamTitle(raw: string): string | null {
  let title = "";
  for (const char of raw.trim()) {
    if (title.length + char.length > TITLE_MAX_LENGTH) break;
    title += char;
  }
  return title || null;
}
