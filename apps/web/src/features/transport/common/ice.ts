/**
 * ICE 設定取得（docs/specs/streaming.md §5）。
 *
 * 每次建立連線前呼叫 `GET /api/rooms/:roomId/ice`（TURN 憑證有時效）。
 * 不從 lib/api.ts 匯入，直接走注入的 fetch，方便測試。
 */
import { iceResponseSchema } from "@project/shared";
import { TransportError } from "./errors";

export interface FetchIceServersOptions {
  signal?: AbortSignal;
  /**
   * 測試用；省略時用全域 fetch。型別比 `typeof fetch` 窄（url 一定是 string），
   * 這樣測試注入 `(url: string, init?) => Promise<Response>` 也相容。
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** 每次建連線前呼叫：取得 ICE servers。失敗一律拋 `TransportError("ICE_UNAVAILABLE")`。 */
export async function fetchIceServers(
  roomId: string,
  token: string,
  options: FetchIceServersOptions = {},
): Promise<RTCIceServer[]> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`/api/rooms/${encodeURIComponent(roomId)}/ice`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: options.signal,
    });
  } catch (error) {
    throw new TransportError("ICE_UNAVAILABLE", "取得 ICE 設定失敗", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new TransportError(
      "ICE_UNAVAILABLE",
      `取得 ICE 設定失敗（HTTP ${response.status}）`,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  const result = iceResponseSchema.safeParse(body);
  if (!result.success) {
    throw new TransportError("ICE_UNAVAILABLE", "ICE 設定格式錯誤");
  }
  // shared 的 IceServer 與 DOM 的 RTCIceServer 欄位相同（urls/username/credential）。
  return result.data.iceServers as RTCIceServer[];
}

/** 傳輸層建連線前取 ICE：有注入的 `fetchIceServers` 就用它（測試），否則打 API。 */
export async function loadIceServers(
  options: {
    fetchIceServers?: () => Promise<RTCIceServer[]>;
    roomId: string;
    token: string;
  },
  signal: AbortSignal,
): Promise<RTCIceServer[]> {
  try {
    return await (options.fetchIceServers
      ? options.fetchIceServers()
      : fetchIceServers(options.roomId, options.token, { signal }));
  } catch {
    throw new TransportError("ICE_UNAVAILABLE", "無法取得 ICE 設定");
  }
}
