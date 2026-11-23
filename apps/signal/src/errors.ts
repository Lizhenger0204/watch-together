import type { ErrorCode } from "@project/shared";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  STREAM_NOT_LIVE: 409,
  RATE_LIMITED: 429,
  RELAY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  BAD_REQUEST: "請求格式錯誤",
  UNAUTHORIZED: "身份驗證失敗",
  FORBIDDEN: "沒有權限執行這個操作",
  ROOM_NOT_FOUND: "找不到房間或邀請碼無效",
  ROOM_FULL: "房間已滿",
  STREAM_NOT_LIVE: "房主尚未開播",
  RATE_LIMITED: "嘗試次數過多，請稍後再試",
  RELAY_UNAVAILABLE: "轉發模式目前無法使用",
  INTERNAL: "伺服器發生錯誤",
};

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = DEFAULT_MESSAGE[code],
  ) {
    super(message);
  }

  get status() {
    return STATUS[this.code];
  }
}

export function errorBody(code: ErrorCode, message = DEFAULT_MESSAGE[code]) {
  return { error: { code, message } };
}

export function errorStatus(code: ErrorCode) {
  return STATUS[code];
}

/** 跨 DO RPC 時不保留 class，用純物件傳遞結果。 */
export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };
