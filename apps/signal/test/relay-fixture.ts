import { env } from "cloudflare:test";
import { createApp } from "../src/app";
import { workersServices } from "../src/runtime/workers/services";
import { BASE } from "./room-fixture";

export const REALTIME = {
  REALTIME_APP_ID: "test-app",
  REALTIME_APP_TOKEN: "private-realtime-credential",
};

const route = createApp(workersServices);

export const endpoint =
  "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions";
const sdp = (direction: string) =>
  [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=mid:0",
    `a=${direction}`,
    "",
  ].join("\r\n");
export const publishOffer = sdp("sendonly");
export const subscribeOffer = sdp("recvonly");

export function request(
  path: string,
  token?: string,
  body?: string,
  options: {
    bindings?: Partial<typeof REALTIME>;
    contentType?: string;
  } = {},
) {
  return route.request(
    `${BASE}${path}`,
    {
      method: body === undefined ? "DELETE" : "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined
          ? { "Content-Type": options.contentType ?? "application/sdp" }
          : {}),
      },
      body,
    },
    { ...env, ...(options.bindings ?? REALTIME) },
  );
}
