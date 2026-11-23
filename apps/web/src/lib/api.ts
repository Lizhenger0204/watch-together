import { z } from "zod";

const healthSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.number().int(),
});

export async function getHealth(signal: AbortSignal) {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) {
    throw new Error("無法取得服務狀態");
  }
  return healthSchema.parse(await response.json());
}
