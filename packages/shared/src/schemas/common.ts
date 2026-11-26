import { z } from "zod";
import {
  CHAT_MAX_LENGTH,
  CHAT_RAW_MAX_LENGTH,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  NICKNAME_MAX_LENGTH,
  SDP_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "../constants";
import { chatTextLength, normalizeChatText } from "../chat-text";

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

/** 畫質三條滑桿的檔位（streaming.md §2）。`"source"` 代表沿用原片（解析度：不縮放）。 */
export const RESOLUTION_STEPS = [720, 900, 1080, 1440, 2160, "source"] as const;
export const BITRATE_STEPS = [
  8_000_000,
  10_000_000,
  15_000_000,
  25_000_000,
  40_000_000,
  "source",
] as const;
export const FRAMERATE_STEPS = [24, 30, 60, "source"] as const;

export const qualitySchema = z.strictObject({
  height: z.literal(RESOLUTION_STEPS),
  bitrate: z.literal(BITRATE_STEPS),
  fps: z.literal(FRAMERATE_STEPS),
});
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

/** 加入冪等鍵：32 bytes 隨機值的 base64url。機密，與 token 同等對待。 */
export const joinKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** 邀請碼換碼版本（初始 0，每次成功換碼遞增）。 */
export const inviteCodeVersionSchema = z.number().int().min(0);

export const roomInfoSchema = z.object({
  roomId: idSchema,
  locked: z.boolean(),
  mode: modeSchema,
  quality: qualitySchema,
  createdAt: z.number().int(),
  /** 只在房主收到的訊息中出現。 */
  inviteCode: inviteCodeSchema.optional(),
  /** 只在房主收到的訊息中出現，初始 0，每次換碼遞增。 */
  inviteCodeVersion: inviteCodeVersionSchema.optional(),
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

const withinChatLength = (min: number, max: number) => (value: string) => {
  const length = chatTextLength(value);
  return length >= min && length <= max;
};

/** 聊天文字：換行正規化為空白、去掉前後空白，結果須為 1–200 字（以 code point 計，見 chat-text.ts）。 */
export const chatTextSchema = z
  .string()
  .refine(withinChatLength(0, CHAT_RAW_MAX_LENGTH))
  .transform(normalizeChatText)
  .pipe(z.string().refine(withinChatLength(1, CHAT_MAX_LENGTH)));

export const chatMessageSchema = z.object({
  id: idSchema,
  memberId: idSchema,
  nickname: nicknameSchema,
  role: roleSchema,
  text: z.string().refine(withinChatLength(1, CHAT_MAX_LENGTH)),
  sentAt: z.number().int(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
