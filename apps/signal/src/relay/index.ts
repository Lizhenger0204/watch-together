import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { AppError } from "../errors";
import { createRealtime, type RelayTrack } from "./realtime";
import { readOffer } from "./sdp";

export type { RelayEnv } from "./realtime";

export type RelayResource = {
  id: string;
  ownerId: string;
  /** 發出 POST 時的成員世代。舊資源未儲存此欄位。 */
  ownerGeneration?: number;
  sessionId: string;
  tracks: RelayTrack[];
  // A subscriber references the exact publication it joined.
  publicationId: string | null;
};

function streamNotLive(role: "whip" | "whep") {
  return new AppError(
    "STREAM_NOT_LIVE",
    role === "whip" ? "請先切換到轉發模式再發布" : "目前沒有可收看的轉發直播",
  );
}

export function createRelayRoutes({
  requireHost,
  requireMember,
  fetch: fetchRealtime = (...args) => fetch(...args),
}: {
  requireHost: MiddlewareHandler<AppEnv>;
  requireMember: MiddlewareHandler<AppEnv>;
  fetch?: typeof fetch;
}) {
  const routes = new Hono<AppEnv>();

  for (const role of ["whip", "whep"] as const) {
    routes.post(
      `/${role}`,
      role === "whip" ? requireHost : requireMember,
      async (c) => {
        const { roomId, memberId, mode, relayGeneration } = c.var.member;
        if (mode !== "relay") throw streamNotLive(role);
        const realtime = createRealtime(c.env ?? {}, fetchRealtime);
        const { relay } = c.var.services;
        if (
          c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/sdp"
        ) {
          throw new AppError("BAD_REQUEST");
        }
        const offer = new TextDecoder().decode(await c.req.arrayBuffer());
        const media = readOffer(offer);
        const publication =
          role === "whep" ? await relay.getPublication(roomId) : null;
        if (role === "whep" && !publication) throw streamNotLive(role);

        const tracks = publication
          ? publication.tracks.map(({ trackName }) => ({
              location: "remote" as const,
              sessionId: publication.sessionId,
              trackName,
            }))
          : media
              .filter(
                ({ active, direction }) =>
                  active && direction.startsWith("a=send"),
              )
              .map(({ mid }) => ({
                location: "local" as const,
                mid,
                trackName: `media-${mid}`,
              }));
        if (!tracks.length) throw new AppError("BAD_REQUEST");
        const id = crypto.randomUUID();
        const resourceFor = (
          sessionId: string,
          tracks: RelayTrack[],
        ): RelayResource => ({
          id,
          ownerId: memberId,
          ownerGeneration: relayGeneration,
          sessionId,
          tracks,
          publicationId: publication?.id ?? null,
        });
        async function rollback(sessionId: string, tracks: RelayTrack[]) {
          if (!tracks.length) return;
          try {
            await realtime.closeTracks(
              sessionId,
              tracks.map(({ mid }) => mid),
            );
          } catch {
            await relay
              .retainForCleanup(roomId, resourceFor(sessionId, tracks))
              .catch(() => {
                console.log(JSON.stringify({ event: "relay.cleanup_lost" }));
              });
          }
        }

        const session = await realtime.open(offer, tracks, rollback);
        try {
          const result = await relay.register(
            roomId,
            resourceFor(session.sessionId, session.tracks),
          );
          if (!result.ok) {
            throw result.code === "STREAM_NOT_LIVE"
              ? new AppError(
                  result.code,
                  "房間狀態已變更，請確認轉發狀態後重試",
                )
              : new AppError(result.code);
          }
        } catch (error) {
          await rollback(session.sessionId, session.tracks);
          throw error;
        }
        return c.body(session.sdp, 201, {
          "Content-Type": "application/sdp",
          Location: `/api/rooms/${roomId}/relay/${id}`,
          "Cache-Control": "no-store",
        });
      },
    );
  }

  routes.delete("/relay/:resourceId", requireMember, async (c) => {
    const realtime = createRealtime(c.env ?? {}, fetchRealtime);
    const { roomId, memberId } = c.var.member;
    const { relay } = c.var.services;
    const resourceId = c.req.param("resourceId");
    const resource = await relay.getResource(roomId, resourceId);
    if (!resource || resource.ownerId !== memberId)
      throw new AppError("FORBIDDEN");
    await realtime.closeTracks(
      resource.sessionId,
      resource.tracks.map(({ mid }) => mid),
    );
    await relay.remove(roomId, resourceId);
    return c.body(null, 200);
  });
  return routes;
}
