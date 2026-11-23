import {
  PROTOCOL_VERSION,
  createRoomRequestSchema,
  joinRoomRequestSchema,
  normalizeInviteCode,
  type ErrorCode,
} from "@project/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { z } from "zod";
import { AppError, errorBody, errorStatus } from "./errors";
import { createIceRoutes, type TurnEnv } from "./ice";
import { createRelayRoutes, type RelayEnv } from "./relay";
import { isRoomId } from "./room/crypto";
import type { AuthedMember, Services } from "./services";

export type AppEnv = {
  Bindings: TurnEnv & RelayEnv;
  Variables: { services: Services; member: AuthedMember };
};

type Ctx = Context<AppEnv>;

function fail(c: Ctx, code: ErrorCode) {
  return c.json(errorBody(code), errorStatus(code) as 400);
}

async function parseBody<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("BAD_REQUEST");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError("BAD_REQUEST");
  return result.data;
}

function bearerToken(c: Ctx) {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1] ?? null;
}

/** 驗證 `Authorization: Bearer <token>` 是 `:roomId` 的成員。 */
export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const roomId = c.req.param("roomId") ?? "";
  const token = bearerToken(c);
  if (!isRoomId(roomId) || !token) return fail(c, "UNAUTHORIZED");
  const result = await c.var.services.rooms.authenticate(roomId, token);
  if (!result.ok) return fail(c, result.code);
  c.set("member", { roomId, ...result.value });
  await next();
};

export const requireHost: MiddlewareHandler<AppEnv> = async (c, next) =>
  requireMember(c, async () => {
    if (c.var.member.role !== "host") {
      c.res = fail(c, "FORBIDDEN");
      return;
    }
    await next();
  });

/** `resolveServices` 由 runtime 提供（Workers 或之後的 Node）。 */
export function createApp(resolveServices: (c: Ctx) => Services) {
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    c.set("services", resolveServices(c));
    await next();
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, protocolVersion: PROTOCOL_VERSION }),
  );

  app.post("/api/rooms", async (c) => {
    const { nickname } = await parseBody(c, createRoomRequestSchema);
    return c.json(await c.var.services.rooms.createRoom(nickname), 201);
  });

  app.post("/api/rooms/join", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    if (!(await c.var.services.joinLimiter.allow(ip))) {
      return fail(c, "RATE_LIMITED");
    }
    const body = await parseBody(c, joinRoomRequestSchema);
    const inviteCode = normalizeInviteCode(body.inviteCode);
    if (!inviteCode) return fail(c, "ROOM_NOT_FOUND");
    const result = await c.var.services.rooms.joinRoom(
      inviteCode,
      body.nickname,
    );
    return result.ok ? c.json(result.value) : fail(c, result.code);
  });

  app.post("/api/rooms/:roomId/invite-code", requireHost, async (c) => {
    const { roomId, memberId } = c.var.member;
    const result = await c.var.services.rooms.regenerateInviteCode(
      roomId,
      memberId,
    );
    return result.ok ? c.json(result.value) : fail(c, result.code);
  });

  app.get("/api/rooms/:roomId/ws", async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.json(errorBody("BAD_REQUEST", "需要 WebSocket 連線"), 426);
    }
    // roomId 格式錯誤也交給 connect：和不存在的房間一樣以 4001 關閉，前端才不會無限重連。
    return c.var.services.rooms.connect(c.req.param("roomId"), c.req.raw);
  });

  app.route(
    "/api/rooms/:roomId/ice",
    createIceRoutes<AppEnv>({ requireMember }),
  );

  app.route(
    "/api/rooms/:roomId",
    createRelayRoutes({ requireHost, requireMember }),
  );

  app.notFound((c) => c.json(errorBody("BAD_REQUEST", "找不到這個 API"), 404));

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(errorBody(error.code, error.message), error.status as 400);
    }
    console.log(
      JSON.stringify({ event: "http.unhandled_error", message: String(error) }),
    );
    return fail(c, "INTERNAL");
  });

  return app;
}
