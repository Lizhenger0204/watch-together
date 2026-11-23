import { iceResponseSchema } from "@project/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { createIceRoutes, getIceServers, type TurnEnv } from "../src/ice";

const stunServers = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.miwifi.com:3478"] },
];
const turnServer = {
  urls: [
    "turn:turn.cloudflare.com:3478?transport=udp",
    "turns:turn.cloudflare.com:443?transport=tcp",
  ],
  username: "fake-username",
  credential: "fake-credential",
};
const env = { TURN_KEY_ID: "fake-key-id", TURN_KEY_TOKEN: "fake-key-token" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([
  {},
  { TURN_KEY_ID: env.TURN_KEY_ID },
  { TURN_KEY_TOKEN: env.TURN_KEY_TOKEN },
])(
  "returns STUN without making a request when TURN configuration is incomplete",
  async (partialEnv) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await getIceServers({ env: partialEnv, fetch })).toEqual(
      stunServers,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '{"event":"ice.turn_fallback","reason":"not_configured"}',
    );
  },
);

test("requests four-hour credentials and returns STUN plus TURN", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json(
      {
        iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, turnServer],
      },
      { status: 201 },
    ),
  );

  expect(await getIceServers({ env, fetch })).toEqual([
    ...stunServers,
    turnServer,
  ]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://rtc.live.cloudflare.com/v1/turn/keys/fake-key-id/credentials/generate-ice-servers",
    expect.objectContaining({
      method: "POST",
      headers: {
        Authorization: "Bearer fake-key-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 14_400 }),
    }),
  );
});

test("drops port 53 TURN URLs but keeps the other URLs of the same server", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      iceServers: [
        {
          urls: [
            "turn:turn.cloudflare.com:53?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turn:turn.cloudflare.com:53",
          ],
          username: "u",
          credential: "c",
        },
        { urls: "turn:turn.cloudflare.com:53", username: "u", credential: "c" },
      ],
    }),
  );

  expect(await getIceServers({ env, fetch })).toEqual([
    ...stunServers,
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
      ],
      username: "u",
      credential: "c",
    },
  ]);
});

test.each([
  () => new Response(null, { status: 503 }),
  () => new Response("invalid JSON"),
  () => Response.json({ iceServers: [{ urls: 42 }] }),
  () => Response.json({ iceServers: [{ urls: turnServer.urls }] }),
  () => Response.json({ iceServers: [] }),
  () => Promise.reject(new Error(env.TURN_KEY_TOKEN)),
])(
  "falls back to STUN on an upstream failure without logging secrets",
  async (makeResponse) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => makeResponse());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await getIceServers({ env, fetch })).toEqual(stunServers);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '{"event":"ice.turn_fallback","reason":"upstream_failure"}',
    );
  },
);

test.each(["fetch", "body"])(
  "falls back and aborts when the %s exceeds five seconds",
  async (stage) => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (stage === "fetch") return new Promise<Response>(() => {});
      const response = new Response();
      vi.spyOn(response, "json").mockImplementation(
        () => new Promise(() => {}),
      );
      return response;
    });
    const result = getIceServers({ env, fetch });
    const signal = fetch.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal?.aborted).toBe(false);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(signal?.aborted).toBe(true);
    expect(await result).toEqual(stunServers);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '{"event":"ice.turn_fallback","reason":"timeout"}',
    );
  },
);

test("serves ICE configuration with no-store after member middleware allows access", async () => {
  type RouteEnv = { Bindings: TurnEnv };
  const requireMember: MiddlewareHandler<RouteEnv> = async (context, next) => {
    if (context.req.header("Authorization") !== "Bearer fake-member") {
      return context.text("Unauthorized", 401);
    }
    await next();
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      Response.json({ iceServers: [turnServer] }, { status: 201 }),
    );
  const app = new Hono<RouteEnv>().route(
    "/api/ice",
    createIceRoutes({ requireMember, fetch }),
  );

  expect((await app.request("/api/ice", {}, env)).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();

  const response = await app.request(
    "/api/ice",
    {
      headers: { Authorization: "Bearer fake-member" },
    },
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(iceResponseSchema.parse(await response.json())).toEqual({
    iceServers: [...stunServers, turnServer],
  });
});
