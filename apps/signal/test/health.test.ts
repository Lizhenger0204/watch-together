import { PROTOCOL_VERSION } from "@project/shared";
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("GET /api/health returns the protocol version", async () => {
  const response = await SELF.fetch("https://example.com/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
  });
});
