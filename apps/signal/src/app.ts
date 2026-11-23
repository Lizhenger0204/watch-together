import { PROTOCOL_VERSION } from "@project/shared";
import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (context) =>
  context.json({ ok: true, protocolVersion: PROTOCOL_VERSION }),
);

export default app;
