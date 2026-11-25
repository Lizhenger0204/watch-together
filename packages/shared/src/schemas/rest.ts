import { z } from "zod";
import { JOIN_MAX_EXCLUDED_ROOMS } from "../constants";
import {
  errorCodeSchema,
  iceServerSchema,
  idSchema,
  inviteCodeSchema,
  inviteCodeVersionSchema,
  joinKeySchema,
  nicknameSchema,
  tokenSchema,
} from "./common";

export const errorResponseSchema = z.object({
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.number().int(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// POST /api/rooms
export const createRoomRequestSchema = z.object({ nickname: nicknameSchema });
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export const createRoomResponseSchema = z.object({
  roomId: idSchema,
  inviteCode: inviteCodeSchema,
  hostToken: tokenSchema,
  memberId: idSchema,
});
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

const roomUuidSchema = z.uuid().transform((id) => id.toLowerCase());

// POST /api/rooms/join
/** inviteCode 接受使用者原始輸入，伺服器用 normalizeInviteCode 正規化。 */
export const joinRoomRequestSchema = z.object({
  inviteCode: z.string().min(1).max(32),
  nickname: nicknameSchema,
  existingRoomId: roomUuidSchema.optional(),
  excludeRoomIds: z
    .array(roomUuidSchema)
    .max(JOIN_MAX_EXCLUDED_ROOMS)
    .optional(),
  /** 同一次加入重試時沿用已配置的席位；沿用請求（existingRoomId）忽略此欄。 */
  joinKey: joinKeySchema.optional(),
});
export type JoinRoomRequest = z.infer<typeof joinRoomRequestSchema>;
export const joinRoomResponseSchema = z.object({
  roomId: idSchema,
  memberToken: tokenSchema,
  memberId: idSchema,
});
export type JoinRoomResponse = z.infer<typeof joinRoomResponseSchema>;

export const reuseRoomResponseSchema = z.strictObject({
  roomId: idSchema,
  memberId: idSchema,
  reused: z.literal(true),
});
export type ReuseRoomResponse = z.infer<typeof reuseRoomResponseSchema>;

// POST /api/rooms/:roomId/invite-code
export const regenerateInviteCodeResponseSchema = z.object({
  inviteCode: inviteCodeSchema,
  inviteCodeVersion: inviteCodeVersionSchema,
});
export type RegenerateInviteCodeResponse = z.infer<
  typeof regenerateInviteCodeResponseSchema
>;

// GET /api/rooms/:roomId/ice
export const iceResponseSchema = z.object({
  iceServers: z.array(iceServerSchema),
});
export type IceResponse = z.infer<typeof iceResponseSchema>;
