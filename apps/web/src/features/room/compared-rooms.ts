// 邀請碼 → 已確認「不是這個碼的房間」的身份（房號＋憑證）。遇到加入限流時，
// 下一個時窗從尚未比對的房號接著比，全部比完就直接回傳原本的滿房或超限提示。
// 只存在分頁記憶體；邀請碼對應的房間不會改變，憑證換了就重新比對。
// 身份清除或憑證換掉時淘汰對應項；邀請碼數量有上限，超過就淘汰最久沒用的。

/** 最多記住幾個邀請碼的比對結果。 */
export const COMPARED_CODES_MAX = 8;

/** 邀請碼 → (房號 → 比對當時的憑證)。Map 的插入順序即最近使用順序。 */
const compared = new Map<string, Map<string, string>>();

/** 淘汰憑證已清除或已換掉的項目；沒有任何項目的邀請碼也一併移除。 */
function prune(currentToken: (roomId: string) => string | null) {
  for (const [code, rooms] of compared) {
    for (const [roomId, token] of rooms) {
      if (currentToken(roomId) !== token) rooms.delete(roomId);
    }
    if (!rooms.size) compared.delete(code);
  }
}

/** 標為最近使用；超過上限就淘汰最久沒用的邀請碼。 */
function touch(inviteCode: string) {
  const rooms = compared.get(inviteCode) ?? new Map<string, string>();
  compared.delete(inviteCode);
  compared.set(inviteCode, rooms);
  for (const code of compared.keys()) {
    if (compared.size <= COMPARED_CODES_MAX) break;
    compared.delete(code);
  }
  return rooms;
}

export const comparedRooms = {
  /** 取得某邀請碼的比對紀錄（標為最近使用），順便淘汰失效的項目。 */
  forCode(inviteCode: string, currentToken: (roomId: string) => string | null) {
    prune(currentToken);
    if (compared.has(inviteCode)) touch(inviteCode);
    // 每次都重新查表：比對途中其他房的身份可能被清除，空的邀請碼會被移除。
    return {
      has: (roomId: string, token: string) =>
        compared.get(inviteCode)?.get(roomId) === token,
      add: (roomId: string, token: string) =>
        void touch(inviteCode).set(roomId, token),
    };
  },
  /** 某房的身份已清除：所有邀請碼底下的對應項一併淘汰。 */
  forget(roomId: string) {
    for (const [code, rooms] of compared) {
      rooms.delete(roomId);
      if (!rooms.size) compared.delete(code);
    }
  },
  /** 測試用：列出各邀請碼底下記住的房號。 */
  entries(): [string, string[]][] {
    return [...compared].map(([code, rooms]) => [code, [...rooms.keys()]]);
  },
  clear() {
    compared.clear();
  },
};
