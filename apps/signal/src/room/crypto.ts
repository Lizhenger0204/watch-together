import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from "@project/shared";

// 只用標準 Web Crypto（Workers 與 Node 22 都有），保持可移植。

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 32 bytes 隨機，base64url。 */
export function generateToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return base64Url(new Uint8Array(digest));
}

export function generateId() {
  return crypto.randomUUID();
}

/** 用拒絕取樣避免取模偏差。 */
export function generateInviteCode() {
  const n = INVITE_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = "";
  while (code.length < INVITE_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && code.length < INVITE_CODE_LENGTH) {
        code += INVITE_CODE_ALPHABET[byte % n];
      }
    }
  }
  return code;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRoomId(value: string) {
  return UUID.test(value);
}
