import { describe, expect, it } from "vitest";
import { fetchIceServers } from "./ice";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe("fetchIceServers", () => {
  it("returns the ice servers on success", async () => {
    const fetch = async () => okResponse({ iceServers: [{ urls: "stun:x" }] });
    const servers = await fetchIceServers("room", "token", { fetch });
    expect(servers).toEqual([{ urls: "stun:x" }]);
  });

  it("sends the bearer token and encodes the room id", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return okResponse({ iceServers: [] });
    };

    await fetchIceServers("a b", "tok", { fetch });

    expect(calls[0]?.url).toBe("/api/rooms/a%20b/ice");
    expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("throws ICE_UNAVAILABLE on an HTTP error", async () => {
    const fetch = async () =>
      ({ ok: false, status: 401, json: async () => ({}) }) as Response;
    await expect(fetchIceServers("r", "t", { fetch })).rejects.toMatchObject({
      code: "ICE_UNAVAILABLE",
    });
  });

  it("throws ICE_UNAVAILABLE on a network error", async () => {
    const fetch = async () => {
      throw new Error("down");
    };
    await expect(fetchIceServers("r", "t", { fetch })).rejects.toMatchObject({
      code: "ICE_UNAVAILABLE",
    });
  });

  it("throws ICE_UNAVAILABLE on a malformed body", async () => {
    const fetch = async () => okResponse({ nope: 1 });
    await expect(fetchIceServers("r", "t", { fetch })).rejects.toMatchObject({
      code: "ICE_UNAVAILABLE",
    });
  });
});
