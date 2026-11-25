import { TITLE_MAX_LENGTH } from "@project/shared";

// 房主端的「開播意圖」：房主按開始直播就成立，按停止才清除（存在分頁的 sessionStorage）。
// 依意圖、片源與伺服器狀態送 stream:status 的邏輯在 host-session.ts。

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 片名送出前截到 TITLE_MAX_LENGTH（UTF-16 長度，即 shared schema 的 max）。
 * 以字素（grapheme）為單位截斷，不切斷組合 emoji（ZWJ 序列、膚色、旗幟）或組合字元。
 */
export function streamTitle(raw: string): string | null {
  let title = "";
  for (const { segment } of graphemes.segment(raw.trim())) {
    if (title.length + segment.length > TITLE_MAX_LENGTH) break;
    title += segment;
  }
  return title || null;
}
