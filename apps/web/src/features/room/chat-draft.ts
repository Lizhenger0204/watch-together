import { clampChatRawText } from "@project/shared";

/**
 * 送出失敗時把這次送出的文字放回輸入框：送出當下已清空輸入框，
 * 等待確認期間新打的字接在後面，避免成功後殘留已送出的文字而重送。
 */
export function restoreUnsentDraft(sent: string, current: string): string {
  return clampChatRawText(current ? `${sent}${current}` : sent);
}
