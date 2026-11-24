import { describe, expect, test } from "vitest";
import {
  PROTOCOL_VERSION,
  QUALITY_PRESETS,
  SDP_MAX_LENGTH,
  createRoomRequestSchema,
  joinRoomRequestSchema,
  parseClientMessage,
  parseServerMessage,
  qualitySchema,
} from "../src";

const token = "x".repeat(43);
const client = (m: unknown) => parseClientMessage(JSON.stringify(m));
const server = (m: unknown) => parseServerMessage(JSON.stringify(m));

describe("parseClientMessage：合法訊息", () => {
  test.each([
    { type: "auth", token, protocolVersion: PROTOCOL_VERSION },
    { type: "room:update", reqId: "1", mode: "relay" },
    { type: "room:update", locked: true },
    { type: "room:update", quality: "high" },
    { type: "room:kick", reqId: "2", memberId: "m1" },
    { type: "stream:status", live: true, title: "電影" },
    { type: "stream:status", live: false, title: null },
    {
      type: "member:status",
      state: "playing",
      bitrateKbps: 5800,
      rttMs: 40,
      packetLoss: 0.01,
    },
    { type: "member:status", state: "waiting" },
    { type: "ping" },
  ])("$type", (m) => {
    expect(client(m)).toMatchObject({ ok: true, message: m });
  });
});

describe("parseClientMessage：不合法訊息", () => {
  test.each([
    ["不是 JSON", "{"],
    ["未知 type", JSON.stringify({ type: "hello" })],
    ["auth 缺 token", JSON.stringify({ type: "auth", protocolVersion: 1 })],
    ["room:update 沒有任何欄位", JSON.stringify({ type: "room:update" })],
    ["mode 不在列舉內", JSON.stringify({ type: "room:update", mode: "cdn" })],
    [
      "SDP 超過上限",
      JSON.stringify({
        type: "signal",
        to: "m1",
        data: {
          type: "offer",
          negotiationId: "offer-1",
          sdp: "x".repeat(SDP_MAX_LENGTH + 1),
        },
      }),
    ],
    [
      "packetLoss 超過 1",
      JSON.stringify({
        type: "member:status",
        state: "playing",
        packetLoss: 2,
      }),
    ],
    [
      "state 不在列舉內",
      JSON.stringify({ type: "member:status", state: "dancing" }),
    ],
  ])("%s", (_name, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});

describe("parseServerMessage", () => {
  const room = {
    roomId: "r1",
    locked: false,
    mode: "p2p",
    quality: "standard",
    createdAt: 1,
  };

  test.each([
    {
      type: "room:snapshot",
      room: { ...room, inviteCode: "ABCDEFGH" },
      members: [
        { memberId: "m1", nickname: "小明", role: "host", online: true },
      ],
      stream: { live: false, title: null, startedAt: null },
      you: { memberId: "m1", role: "host" },
    },
    { type: "room:updated", room },
    { type: "room:closed", reason: "kicked" },
    { type: "stream:status", live: true, title: "電影", startedAt: 2 },
    { type: "peer:request", memberId: "m2" },
    { type: "member:status", memberId: "m2", status: { state: "buffering" } },
    { type: "ack", reqId: "1", ok: true },
    { type: "ack", reqId: "1", ok: false, code: "FORBIDDEN" },
    { type: "error", code: "BAD_REQUEST", message: "格式錯誤" },
    { type: "pong" },
  ])("$type", (m) => {
    expect(server(m)).toMatchObject({ ok: true, message: m });
  });

  test("ack 失敗時必須有 code", () => {
    expect(server({ type: "ack", reqId: "1", ok: false }).ok).toBe(false);
  });

  test("邀請碼格式不對會被拒絕", () => {
    expect(
      server({ type: "room:updated", room: { ...room, inviteCode: "abc" } }).ok,
    ).toBe(false);
  });
});

describe.each([
  ["offer", { type: "offer", sdp: "v=0" }],
  ["answer", { type: "answer", sdp: "v=0" }],
  [
    "ICE candidate",
    {
      type: "ice",
      candidate: {
        candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    },
  ],
  ["ICE 結束標記", { type: "ice", candidate: null }],
] as const)("signal %s", (_name, payload) => {
  test("雙向解析都保留 64 字元的協商識別", () => {
    const data = { ...payload, negotiationId: "n".repeat(64) };
    const outgoing = { type: "signal", to: "m1", data };
    const incoming = { type: "signal", from: "m2", data };
    expect(client(outgoing)).toEqual({ ok: true, message: outgoing });
    expect(server(incoming)).toEqual({ ok: true, message: incoming });
  });

  test.each([
    ["缺少協商識別", undefined],
    ["協商識別為空字串", ""],
    ["協商識別超過 64 字元", "n".repeat(65)],
  ])("%s 時雙向都拒絕", (_reason, negotiationId) => {
    const data = { ...payload, negotiationId };
    expect(client({ type: "signal", to: "m1", data }).ok).toBe(false);
    expect(server({ type: "signal", from: "m2", data }).ok).toBe(false);
  });
});

describe("REST 與常數", () => {
  test("加入可指定沿用的房號與禁止增配的房號", () => {
    const roomId = crypto.randomUUID();
    const input = {
      inviteCode: "ABCDEFGH",
      nickname: "朋友",
      existingRoomId: roomId,
      excludeRoomIds: [roomId],
    };
    expect(joinRoomRequestSchema.parse(input)).toEqual(input);
    expect(
      joinRoomRequestSchema.safeParse({ ...input, existingRoomId: "bad" })
        .success,
    ).toBe(false);
    expect(
      joinRoomRequestSchema.safeParse({ ...input, excludeRoomIds: ["bad"] })
        .success,
    ).toBe(false);
  });

  test("暱稱會 trim，空白暱稱不合法", () => {
    expect(createRoomRequestSchema.parse({ nickname: "  小明 " })).toEqual({
      nickname: "小明",
    });
    expect(createRoomRequestSchema.safeParse({ nickname: "   " }).success).toBe(
      false,
    );
    expect(
      createRoomRequestSchema.safeParse({ nickname: "x".repeat(25) }).success,
    ).toBe(false);
  });

  test("每個畫質都有預設值", () => {
    for (const q of qualitySchema.options)
      expect(QUALITY_PRESETS[q]).toBeDefined();
  });
});
