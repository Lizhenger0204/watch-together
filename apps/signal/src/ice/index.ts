import { Hono, type MiddlewareHandler } from "hono";
import { getIceServers, type TurnEnv } from "./get-ice-servers";

export { getIceServers, type TurnEnv } from "./get-ice-servers";

interface IceRouteOptions<E extends { Bindings: TurnEnv }> {
  requireMember: MiddlewareHandler<E>;
  fetch?: typeof fetch;
}

export function createIceRoutes<E extends { Bindings: TurnEnv }>({
  requireMember,
  fetch: fetchTurn = fetch,
}: IceRouteOptions<E>) {
  return new Hono<E>().get("/", requireMember, async (context) => {
    const iceServers = await getIceServers({
      env: (context.env as TurnEnv | undefined) ?? {},
      fetch: fetchTurn,
    });
    return context.json({ iceServers }, 200, { "Cache-Control": "no-store" });
  });
}
