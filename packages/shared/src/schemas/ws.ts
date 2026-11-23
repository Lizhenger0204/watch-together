import { z } from "zod";
import { TITLE_MAX_LENGTH } from "../constants";
import {
  errorCodeSchema,
  idSchema,
  memberSchema,
  memberStatusSchema,
  modeSchema,
  qualitySchema,
  roleSchema,
  roomInfoSchema,
  signalDataSchema,
  streamInfoSchema,
  tokenSchema,
} from "./common";

/** 需要回應的請求可帶 reqId，伺服器以 ack 回覆。 */
const reqId = z.string().min(1).max(64).optional();

// ── 客戶端 → 伺服器 ─────────────────────────────────────────

export const authMessageSchema = z.object({
  type: z.literal("auth"),
  reqId,
  token: tokenSchema,
  protocolVersion: z.number().int(),
});

export const roomUpdateMessageSchema = z
  .object({
    type: z.literal("room:update"),
    reqId,
    locked: z.boolean().optional(),
    mode: modeSchema.optional(),
    quality: qualitySchema.optional(),
  })
  .refine(
    (m) =>
      m.locked !== undefined || m.mode !== undefined || m.quality !== undefined,
    { message: "room:update 至少要有一個欄位" },
  );

export const roomKickMessageSchema = z.object({
  type: z.literal("room:kick"),
  reqId,
  memberId: idSchema,
});

export const clientStreamStatusMessageSchema = z.object({
  type: z.literal("stream:status"),
  reqId,
  live: z.boolean(),
  title: z.string().max(TITLE_MAX_LENGTH).nullable(),
});

export const clientSignalMessageSchema = z.object({
  type: z.literal("signal"),
  to: idSchema,
  data: signalDataSchema,
});

export const clientMemberStatusMessageSchema = memberStatusSchema.extend({
  type: z.literal("member:status"),
});

export const pingMessageSchema = z.object({ type: z.literal("ping") });

// zod 4 的 refine 不會改變 schema 型別，可以直接放進 discriminatedUnion。
export const clientMessageSchema = z.discriminatedUnion("type", [
  authMessageSchema,
  roomUpdateMessageSchema,
  roomKickMessageSchema,
  clientStreamStatusMessageSchema,
  clientSignalMessageSchema,
  clientMemberStatusMessageSchema,
  pingMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── 伺服器 → 客戶端 ─────────────────────────────────────────

export const roomSnapshotMessageSchema = z.object({
  type: z.literal("room:snapshot"),
  room: roomInfoSchema,
  members: z.array(memberSchema),
  stream: streamInfoSchema,
  you: z.object({ memberId: idSchema, role: roleSchema }),
});

export const roomMembersMessageSchema = z.object({
  type: z.literal("room:members"),
  members: z.array(memberSchema),
});

export const roomUpdatedMessageSchema = z.object({
  type: z.literal("room:updated"),
  room: roomInfoSchema,
});

export const roomClosedMessageSchema = z.object({
  type: z.literal("room:closed"),
  reason: z.enum(["expired", "kicked", "host_closed"]),
});

export const serverStreamStatusMessageSchema = streamInfoSchema.extend({
  type: z.literal("stream:status"),
});

export const peerRequestMessageSchema = z.object({
  type: z.literal("peer:request"),
  memberId: idSchema,
});

export const serverSignalMessageSchema = z.object({
  type: z.literal("signal"),
  from: idSchema,
  data: signalDataSchema,
});

export const serverMemberStatusMessageSchema = z.object({
  type: z.literal("member:status"),
  memberId: idSchema,
  status: memberStatusSchema,
});

export const ackMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("ack"),
    reqId: z.string(),
    ok: z.literal(true),
  }),
  z.object({
    type: z.literal("ack"),
    reqId: z.string(),
    ok: z.literal(false),
    code: errorCodeSchema,
  }),
]);

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: errorCodeSchema,
  message: z.string(),
  reqId: z.string().optional(),
});

export const pongMessageSchema = z.object({ type: z.literal("pong") });

export const serverMessageSchema = z.union([
  roomSnapshotMessageSchema,
  roomMembersMessageSchema,
  roomUpdatedMessageSchema,
  roomClosedMessageSchema,
  serverStreamStatusMessageSchema,
  peerRequestMessageSchema,
  serverSignalMessageSchema,
  serverMemberStatusMessageSchema,
  ackMessageSchema,
  errorMessageSchema,
  pongMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<
  ServerMessage,
  { type: T }
>;
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<
  ClientMessage,
  { type: T }
>;

// ── 解析工具 ────────────────────────────────────────────────

export type ParseResult<T> =
  { ok: true; message: T } | { ok: false; error: string };

function parseJson<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "無效的 JSON" };
  }
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseJson(clientMessageSchema, raw);
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseJson(serverMessageSchema, raw);
}
