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
  errorCode: z.string().optional(),
  tracks: z.array(z.unknown()),
});
const addedTrack = z.object({
  ...errorFields,
  mid: identifier,
  trackName: identifier.optional(),
});
const negotiation = z.object({
  sessionDescription: z.object({ type: z.literal("answer"), sdp: identifier }),
  requiresImmediateRenegotiation: z.literal(false).optional(),
});
const endedSession = z.object({ errorCode: z.literal("session_error") });
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

  async function call(path: string, method: "POST" | "PUT", body?: unknown) {
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
      const data: unknown = await result.json();
      return { ok: result.ok, status: result.status, data };
    } catch {
      // Upstream error details may contain credentials or SDP.
    }
    throw new AppError("RELAY_UNAVAILABLE");
  }

  async function closeTracks(sessionId: string, mids: string[]) {
    if (!mids.length) return;
    const response = await call(`/${sessionId}/tracks/close`, "PUT", {
      tracks: mids.map((mid) => ({ mid })),
      force: true,
    });
    if (
      response.status === 410 &&
      endedSession.safeParse(response.data).success
    )
      return;
    const result = closeResult.safeParse(response.data);
    if (
      !response.ok ||
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
    async open(
      sdp: string,
      tracks: TrackRequest[],
      rollback: (sessionId: string, tracks: RelayTrack[]) => Promise<void>,
    ) {
      const created = await call("/new", "POST");
      const session = newSession.safeParse(created.data);
      if (!created.ok || !session.success)
        throw new AppError("RELAY_UNAVAILABLE");
      const { sessionId } = session.data;
      const response = await call(`/${sessionId}/tracks/new`, "POST", {
        sessionDescription: { type: "offer", sdp },
        tracks,
      });
      const results = trackResults.safeParse(response.data);
      const answer = negotiation.safeParse(response.data);
      // 一個 track 失敗（可能沒有 mid）也要保留同一個回應中已建立的 tracks。
      const added = results.success
        ? results.data.tracks.flatMap((raw) => {
            const track = addedTrack.safeParse(raw);
            return track.success ? [track.data] : [];
          })
        : [];
      const matched = tracks.map(({ trackName }) =>
        added.find((track) => track.trackName === trackName),
      );
      if (
        !response.ok ||
        !results.success ||
        results.data.errorCode ||
        results.data.tracks.length !== added.length ||
        !answer.success ||
        added.length !== tracks.length ||
        new Set(added.map(({ mid }) => mid)).size !== tracks.length ||
        matched.some((track) => !track) ||
        answer.data.sessionDescription.sdp.includes(REALTIME_APP_TOKEN)
      ) {
        // 上游可能只提供 mid；清理只依 sessionId 與 mid 關閉已建立的 tracks。
        await rollback(
          sessionId,
          added.map(({ mid, trackName }) => ({
            mid,
            trackName: trackName ?? "",
          })),
        );
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
