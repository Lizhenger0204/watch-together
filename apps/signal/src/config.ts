import { WS_AUTH_TIMEOUT_MS, WS_HEARTBEAT_TIMEOUT_MS } from "@project/shared";
import { z } from "zod";

const configSchema = z.object({
  ROOM_MAX_MEMBERS: z.coerce.number().int().min(2).max(32).default(8),
  ROOM_IDLE_TTL_MS: z.coerce.number().int().min(1000).default(100_000),
  ROOM_HOST_OFFLINE_TTL_MS: z.coerce.number().int().min(1000).default(100_000),
  ROOM_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(24 * 60 * 60_000),
});

export type RoomConfig = {
  /** 含房主。 */
  maxMembers: number;
  /** 最後一人離線後多久關房。 */
  idleTtlMs: number;
  /** 房主離線多久後自動移出房間。 */
  hostOfflineTtlMs: number;
  /** 建房後最長存活時間。 */
  maxAgeMs: number;
  /** 離線超過此時間的收看者在有人加入時會被移除，騰出名額。 */
  staleMemberMs: number;
  /** WebSocket 連線後必須在此時間內通過 auth。 */
  authTimeoutMs: number;
  /** 已驗證連線超過此時間沒有任何訊息就視為斷線。 */
  heartbeatTimeoutMs: number;
};

export function readRoomConfig(env: Record<string, unknown>): RoomConfig {
  const parsed = configSchema.parse(env);
  return {
    maxMembers: parsed.ROOM_MAX_MEMBERS,
    idleTtlMs: parsed.ROOM_IDLE_TTL_MS,
    hostOfflineTtlMs: parsed.ROOM_HOST_OFFLINE_TTL_MS,
    maxAgeMs: parsed.ROOM_MAX_AGE_MS,
    staleMemberMs: 10 * 60_000,
    authTimeoutMs: WS_AUTH_TIMEOUT_MS,
    heartbeatTimeoutMs: WS_HEARTBEAT_TIMEOUT_MS,
  };
}
