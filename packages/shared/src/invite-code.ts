import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from "./constants";

const VALID = new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

/**
 * 把使用者輸入正規化成 8 碼大寫邀請碼：不分大小寫、忽略 `-` 與空白。
 * 不合法時回傳 null（長度不對或含字元集以外的字元）。
 */
export function normalizeInviteCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return VALID.test(code) ? code : null;
}

/** 顯示格式 `ABCD-EFGH`。輸入必須是已正規化的邀請碼。 */
export function formatInviteCode(code: string): string {
  const half = INVITE_CODE_LENGTH / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}
