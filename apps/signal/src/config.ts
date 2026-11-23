import { z } from "zod";

const configSchema = z.object({
  ROOM_MAX_MEMBERS: z.coerce.number().int().min(2).max(32).default(8),
  ROOM_IDLE_TTL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(30 * 60_000),
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
  /** 建房後最長存活時間。 */
  maxAgeMs: number;
  /** 離線超過此時間的收看者在有人加入時會被移除，騰出名額。 */
  staleMemberMs: number;
  /** WebSocket 連線後必須在此時間內通過 auth。 */
  authTimeoutMs: number;
};

export function readRoomConfig(env: Record<string, unknown>): RoomConfig {
  const parsed = configSchema.parse(env);
  return {
    maxMembers: parsed.ROOM_MAX_MEMBERS,
    idleTtlMs: parsed.ROOM_IDLE_TTL_MS,
    maxAgeMs: parsed.ROOM_MAX_AGE_MS,
    staleMemberMs: 10 * 60_000,
    authTimeoutMs: 5_000,
  };
}
