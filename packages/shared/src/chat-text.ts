/**
 * 聊天文字的正規化與計數（protocol.md「聊天訊息」）。
 * 前端輸入、字數提示、送出前檢查與伺服器 schema 都用這兩個函式，避免各自算法不同。
 */
/** 換行（連續的 `\r`／`\n`）改為一個空白，再去掉前後空白。 */
export function normalizeChatText(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").trim();
}

/** 字數以 Unicode code point 計算：一個 emoji 算 1 字（由多個 code point 組成的 emoji 依其數量計）。 */
export function chatTextLength(text: string): number {
  return Array.from(text).length;
}
