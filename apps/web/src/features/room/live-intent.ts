import { TITLE_MAX_LENGTH } from "@project/shared";

// 房主端的「開播意圖」：房主按開始直播就成立，按停止才清除（存在分頁的 sessionStorage）。
// 依意圖、片源與伺服器狀態送 stream:status 的邏輯在 host-session.ts。

// 不可在模組頂層建立 Intl.Segmenter：沒有它的瀏覽器（例如 Firefox 125 以前）
// 會在載入時就拋錯，連首頁都打不開。用到時才偵測，沒有就走下面的後備切法。
let segmenter: Intl.Segmenter | null | undefined;

function nativeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  return segmenter;
}

const EXTEND =
  /^(?:\p{M}|\p{Emoji_Modifier}|\u200d|[\ufe00-\ufe0f]|[\u{e0020}-\u{e007f}])$/u;
const REGIONAL = /^\p{Regional_Indicator}$/u;

/**
 * 沒有 Intl.Segmenter 時的近似字素切法：組合字元、ZWJ 與 ZWJ 後的字、變體選擇符、
 * 膚色、旗幟 tag 併入前一個字素；區域指示符兩兩成對（國旗）。
 */
export function fallbackGraphemes(text: string): string[] {
  const clusters: string[] = [];
  let previous = "";
  for (const char of text) {
    const last = clusters.length - 1;
    const pairsFlag =
      REGIONAL.test(char) &&
      last >= 0 &&
      REGIONAL.test(clusters[last]!) &&
      [...clusters[last]!].length === 1;
    if (
      last >= 0 &&
      (EXTEND.test(char) || previous === "\u200d" || pairsFlag)
    ) {
      clusters[last] += char;
    } else {
      clusters.push(char);
    }
    previous = char;
  }
  return clusters;
}

function graphemes(text: string): Iterable<string> {
  const native = nativeSegmenter();
  return native
    ? Array.from(native.segment(text), ({ segment }) => segment)
    : fallbackGraphemes(text);
}

/**
 * 片名送出前截到 TITLE_MAX_LENGTH（UTF-16 長度，即 shared schema 的 max）。
 * 以字素（grapheme）為單位截斷，不切斷組合 emoji（ZWJ 序列、膚色、旗幟）或組合字元。
 */
export function streamTitle(raw: string): string | null {
  let title = "";
  for (const segment of graphemes(raw.trim())) {
    if (title.length + segment.length > TITLE_MAX_LENGTH) break;
    title += segment;
  }
  return title || null;
}
