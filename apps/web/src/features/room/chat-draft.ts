/**
 * 送出失敗時把這次送出的文字放回輸入框：送出當下已清空輸入框，
 * 等待確認期間新打的字接在後面。不截斷，超過上限時由輸入框提示並停用送出，使用者自己刪減。
 */
export function restoreUnsentDraft(sent: string, current: string): string {
  return current ? `${sent}${current}` : sent;
}
