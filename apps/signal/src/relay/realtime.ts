import { z } from "zod";
import { AppError } from "../errors";

const credential = z.string().trim().min(1);
const credentials = z.object({
  REALTIME_APP_ID: credential.regex(/^[\w-]+$/),
  REALTIME_APP_TOKEN: credential,
});

export type RelayEnv = Partial<z.input<typeof credentials>>;

export type RelayTrack = { mid: string; trackName: string };
type TrackRequest =
  | (RelayTrack & { location: "local" })
  | { location: "remote"; sessionId: string; trackName: string };

const identifier = z.string().min(1);
const errorFields = { errorCode: z.literal("").optional() };
const newSession = z.object({
  ...errorFields,
  sessionId: identifier.regex(/^[\w-]+$/),
});
const trackResults = z.object({
  ...errorFields,
  tracks: z
    .array(
      z.object({
        mid: identifier,
        trackName: identifier.optional(),
        errorCode: z.string().optional(),
      }),
    )
    .min(1),
});
const negotiation = z.object({
  sessionDescription: z.object({ type: z.literal("answer"), sdp: identifier }),
  requiresImmediateRenegotiation: z.literal(false).optional(),
});
const closeResult = z.object({
  ...errorFields,
  tracks: z.array(
    z.object({
      mid: identifier,
      errorCode: z.enum(["", "close_track_error"]).optional(),
    }),
  ),
});

export function createRealtime(
  env: RelayEnv,
  fetchRealtime: typeof fetch = fetch,
) {
  const config = credentials.safeParse(env);
  if (!config.success) throw new AppError("RELAY_UNAVAILABLE");
  const { REALTIME_APP_ID, REALTIME_APP_TOKEN } = config.data;
  const base = `https://rtc.live.cloudflare.com/v1/apps/${REALTIME_APP_ID}/sessions`;

  async function call(
    path: string,
    method: "POST" | "PUT",
    body?: unknown,
  ): Promise<unknown> {
    try {
      const result = await fetchRealtime(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${REALTIME_APP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (result.ok) return await result.json();
    } catch {
      // Upstream error details may contain credentials or SDP.
    }
    throw new AppError("RELAY_UNAVAILABLE");
  }

  async function closeTracks(sessionId: string, mids: string[]) {
    if (!mids.length) return;
    const result = closeResult.safeParse(
      await call(`/${sessionId}/tracks/close`, "PUT", {
        tracks: mids.map((mid) => ({ mid })),
        force: true,
      }),
    );
    if (
      !result.success ||
      !mids.every((mid) =>
        result.data.tracks.some((track) => track.mid === mid),
      )
    ) {
      throw new AppError("RELAY_UNAVAILABLE");
    }
  }

  return {
    closeTracks,
    async open(sdp: string, tracks: TrackRequest[]) {
      const session = newSession.safeParse(await call("/new", "POST"));
      if (!session.success) throw new AppError("RELAY_UNAVAILABLE");
      const { sessionId } = session.data;
      const response = await call(`/${sessionId}/tracks/new`, "POST", {
        sessionDescription: { type: "offer", sdp },
        tracks,
      });
      const results = trackResults.safeParse(response);
      const answer = negotiation.safeParse(response);
      const added = results.success
        ? results.data.tracks.filter((track) => !track.errorCode)
        : [];
      const matched = tracks.map(({ trackName }) =>
        added.find((track) => track.trackName === trackName),
      );
      if (
        !answer.success ||
        added.length !== tracks.length ||
        new Set(added.map(({ mid }) => mid)).size !== tracks.length ||
        matched.some((track) => !track) ||
        answer.data.sessionDescription.sdp.includes(REALTIME_APP_TOKEN)
      ) {
        await closeTracks(
          sessionId,
          added.map(({ mid }) => mid),
        ).catch(() => {});
        throw new AppError("RELAY_UNAVAILABLE");
      }
      return {
        sessionId,
        sdp: answer.data.sessionDescription.sdp,
        tracks: tracks.map(({ trackName }, index) => ({
          trackName,
          mid: matched[index]!.mid,
        })),
      };
    },
  };
}
