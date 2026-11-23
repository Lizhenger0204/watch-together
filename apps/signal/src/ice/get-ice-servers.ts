import { iceResponseSchema, type IceServer } from "@project/shared";

const STUN_URLS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.miwifi.com:3478",
] as const;
const TURN_TTL_SECONDS = 4 * 60 * 60;
const TURN_TIMEOUT_MS = 5_000;

export interface TurnEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
}

interface IceDependencies {
  env: TurnEnv;
  fetch: typeof fetch;
}

export async function getIceServers(
  deps: IceDependencies,
): Promise<IceServer[]> {
  const stunServers = [{ urls: [...STUN_URLS] }];
  const { TURN_KEY_ID: keyId, TURN_KEY_TOKEN: token } = deps.env;

  if (
    typeof keyId !== "string" ||
    !keyId.trim() ||
    typeof token !== "string" ||
    !token.trim()
  ) {
    console.log(
      JSON.stringify({ event: "ice.turn_fallback", reason: "not_configured" }),
    );
    return stunServers;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("TURN request timed out"));
    }, TURN_TIMEOUT_MS);
  });

  try {
    const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
    const turnServers = await Promise.race([
      fetchTurnServers(deps.fetch, endpoint, token, controller.signal),
      timeout,
    ]);
    return [...stunServers, ...turnServers];
  } catch {
    const reason = controller.signal.aborted ? "timeout" : "upstream_failure";
    console.log(JSON.stringify({ event: "ice.turn_fallback", reason }));
    return stunServers;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTurnServers(
  fetchTurn: typeof fetch,
  endpoint: string,
  token: string,
  signal: AbortSignal,
): Promise<IceServer[]> {
  const response = await fetchTurn(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error("TURN request failed");
  }

  const { iceServers } = iceResponseSchema.parse(await response.json());
  const turnServers: IceServer[] = [];
  for (const { urls, username, credential } of iceServers) {
    // 瀏覽器會擋 port 53，留著只會拖慢 ICE（Cloudflare TURN 文件也建議過濾）。
    const turnUrls = (typeof urls === "string" ? [urls] : urls).filter(
      (url) => /^turns?:.+/.test(url) && !/:53(\?|$)/.test(url),
    );
    if (turnUrls.length === 0) continue;
    if (!username || !credential) {
      throw new Error("Missing TURN credentials");
    }
    turnServers.push({ urls: turnUrls, username, credential });
  }
  if (turnServers.length === 0) {
    throw new Error("Missing TURN servers");
  }
  return turnServers;
}
