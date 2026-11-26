import {
  createRoomResponseSchema,
  errorResponseSchema,
  healthResponseSchema,
  iceResponseSchema,
  joinRoomResponseSchema,
  regenerateInviteCodeResponseSchema,
  type ErrorCode,
} from "@project/shared";
import type { z } from "zod";

/** 給使用者看的錯誤訊息。程式判斷請看 code。 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: "輸入的資料格式不對，請檢查後再試。",
  UNAUTHORIZED: "身份已失效，請重新加入房間。",
  FORBIDDEN: "只有房主可以這樣做。",
  ROOM_NOT_FOUND: "找不到房間，邀請碼可能打錯或已失效。",
  ROOM_FULL: "房間已滿。",
  RATE_LIMITED: "嘗試太多次了，請等一分鐘再試。",
  STREAM_NOT_LIVE: "房主還沒開始播放。",
  RELAY_UNAVAILABLE: "轉發模式目前無法使用。",
  INTERNAL: "伺服器出了點問題，請稍後再試。",
};

export class ApiError extends Error {
  constructor(readonly code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (error) {
    if (rest.signal?.aborted) throw error;
    throw new ApiError("INTERNAL");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    throw new ApiError(parsed.success ? parsed.data.error.code : "INTERNAL");
  }
  return schema.parse(body);
}

export function getHealth(signal: AbortSignal) {
  return request("/api/health", healthResponseSchema, { signal });
}

export function createRoom(nickname: string) {
  return request("/api/rooms", createRoomResponseSchema, {
    method: "POST",
    body: JSON.stringify({ nickname }),
  });
}

/** joinKey：protocol.md「加入冪等」。機密，只放在請求本文。 */
export function joinRoom(
  inviteCode: string,
  nickname: string,
  joinKey?: string,
) {
  return request("/api/rooms/join", joinRoomResponseSchema, {
    method: "POST",
    redirect: "error",
    body: JSON.stringify({ inviteCode, nickname, joinKey }),
  });
}

export function regenerateInviteCode(roomId: string, token: string) {
  return request(
    `/api/rooms/${roomId}/invite-code`,
    regenerateInviteCodeResponseSchema,
    { method: "POST", token },
  );
}

export async function leaveRoom(roomId: string, token: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/rooms/${roomId}/leave`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError("INTERNAL");
  }
  if (response.status === 204) return;
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(body);
  throw new ApiError(
    response.status >= 500 || !parsed.success
      ? "INTERNAL"
      : parsed.data.error.code,
  );
}

export function getIceServers(roomId: string, token: string) {
  return request(`/api/rooms/${roomId}/ice`, iceResponseSchema, { token });
}
