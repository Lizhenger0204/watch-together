import { z } from "zod";
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  NICKNAME_MAX_LENGTH,
  SDP_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "../constants";

export const errorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "RATE_LIMITED",
  "STREAM_NOT_LIVE",
  "RELAY_UNAVAILABLE",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const modeSchema = z.enum(["p2p", "relay"]);
export type Mode = z.infer<typeof modeSchema>;

export const qualitySchema = z.enum(["smooth", "standard", "high"]);
export type Quality = z.infer<typeof qualitySchema>;

export const roleSchema = z.enum(["host", "member"]);
export type Role = z.infer<typeof roleSchema>;

export const idSchema = z.string().min(1).max(64);

/** 已正規化的邀請碼（伺服器回傳用）。使用者輸入請先用 normalizeInviteCode。 */
export const inviteCodeSchema = z
  .string()
  .regex(new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`));

export const nicknameSchema = z.string().trim().min(1).max(NICKNAME_MAX_LENGTH);

export const tokenSchema = z.string().min(16).max(256);

export const roomInfoSchema = z.object({
  roomId: idSchema,
  locked: z.boolean(),
  mode: modeSchema,
  quality: qualitySchema,
  createdAt: z.number().int(),
  /** 只在房主收到的訊息中出現。 */
  inviteCode: inviteCodeSchema.optional(),
});
export type RoomInfo = z.infer<typeof roomInfoSchema>;

export const memberSchema = z.object({
  memberId: idSchema,
  nickname: nicknameSchema,
  role: roleSchema,
  online: z.boolean(),
});
export type Member = z.infer<typeof memberSchema>;

export const streamInfoSchema = z.object({
  live: z.boolean(),
  title: z.string().max(TITLE_MAX_LENGTH).nullable(),
  startedAt: z.number().int().nullable(),
});
export type StreamInfo = z.infer<typeof streamInfoSchema>;

/** 對應 RTCIceCandidateInit；不依賴 DOM 型別，signal 端也能用。 */
export const iceCandidateSchema = z.object({
  candidate: z.string().max(2048),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export type IceCandidate = z.infer<typeof iceCandidateSchema>;

export const signalDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["offer", "answer"]),
    negotiationId: idSchema,
    sdp: z.string().min(1).max(SDP_MAX_LENGTH),
  }),
  z.object({
    type: z.literal("ice"),
    negotiationId: idSchema,
    /** null 代表這份 offer 的 end-of-candidates。 */
    candidate: iceCandidateSchema.nullable(),
  }),
]);
export type SignalData = z.infer<typeof signalDataSchema>;

export const memberStateSchema = z.enum([
  "waiting",
  "connecting",
  "playing",
  "buffering",
  "failed",
]);
export type MemberState = z.infer<typeof memberStateSchema>;

export const memberStatusSchema = z.object({
  state: memberStateSchema,
  bitrateKbps: z.number().min(0).optional(),
  rttMs: z.number().min(0).optional(),
  packetLoss: z.number().min(0).max(1).optional(),
});
export type MemberStatus = z.infer<typeof memberStatusSchema>;

/** 對應 RTCIceServer。 */
export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string()).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;
