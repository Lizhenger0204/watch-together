import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { AppError, type Result } from "../errors";
import { createRealtime, type RelayTrack } from "./realtime";
import { readOffer } from "./sdp";

export type { RelayEnv } from "./realtime";

export type RelayResource = {
  id: string;
  ownerId: string;
  sessionId: string;
  tracks: RelayTrack[];
  // A subscriber references the exact publication it joined.
  publicationId: string | null;
};

function unwrap<T>(result: Result<T>) {
  if (!result.ok) throw new AppError(result.code);
  return result.value;
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
        const realtime = createRealtime(c.env ?? {}, fetchRealtime);
        const { roomId, memberId } = c.var.member;
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
        if (role === "whep" && !publication)
          throw new AppError("STREAM_NOT_LIVE");

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
        const session = await realtime.open(offer, tracks);
        const id = crypto.randomUUID();
        try {
          unwrap(
            await relay.register(roomId, {
              id,
              ownerId: memberId,
              sessionId: session.sessionId,
              tracks: session.tracks,
              publicationId: publication?.id ?? null,
            }),
          );
        } catch (error) {
          await realtime
            .closeTracks(
              session.sessionId,
              session.tracks.map(({ mid }) => mid),
            )
            .catch(() => {});
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
