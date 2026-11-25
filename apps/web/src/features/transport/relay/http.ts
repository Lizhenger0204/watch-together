/**
 * WHIP／WHEP 的 HTTP 層（docs/specs/streaming.md §4、protocol.md）。
 *
 * - POST：body 是整份本機 offer SDP，帶 `Authorization: Bearer <token>`。
 *   `201` 回 SDP answer 與 `Location`（資源 URL）。
 * - DELETE `<Location>`：停止時釋放資源。
 *
 * 用全域 fetch（測試以 `vi.stubGlobal("fetch")` 替換）。token 是機密，
 * 只放在 Authorization header，不放進 URL、錯誤訊息或 log。
 */
import { TransportError } from "../common";

export type RelayRole = "whip" | "whep";

/** 單次 HTTP offer 前等 ICE 收集的上限（§4）。 */
export const ICE_GATHERING_TIMEOUT_MS = 2_000;

/** DELETE 失敗時的重試間隔：第一次立即送，之後依序等待。 */
export const DELETE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/**
 * `201` 的標頭驗證過就交出：`location` 立刻可用來清理，`answer` 是還在讀取的本文
 * （讀取失敗得到空字串，交給套用 answer 的步驟回報）。
 */
export type RelayResource = { location: string; answer: Promise<string> };

export function relayUrl(roomId: string, role: RelayRole) {
  return `/api/rooms/${encodeURIComponent(roomId)}/${role}`;
}

/** 單次 DELETE 的期限；逾時視為失敗，沿用重試與待清理機制。 */
export const DELETE_TIMEOUT_MS = 5_000;

/** 沒有頁面位址（單元測試）時用來解析相對路徑的 origin。 */
const FALLBACK_BASE = "http://same-origin.invalid/";

/** 實際送出請求的網址：相對路徑依目前頁面解析。 */
function requestUrl(roomId: string, role: RelayRole) {
  const page = (globalThis as { location?: { href?: string } }).location?.href;
  return new URL(relayUrl(roomId, role), page ?? FALLBACK_BASE);
}

/**
 * 只接受同一房間的資源路徑。Location 來自伺服器回應，若不檢查就照著 DELETE，
 * 被竄改的回應可能讓 token 被送到別的網址。相對與同源的絕對網址都依實際請求的
 * origin 解析，回傳的一律是路徑。
 */
function resourcePath(
  roomId: string,
  role: RelayRole,
  location: string | null,
) {
  if (!location) return null;
  const prefix = `/api/rooms/${encodeURIComponent(roomId)}/relay/`;
  let path: string;
  try {
    const request = requestUrl(roomId, role);
    const url = new URL(location, request);
    if (url.origin !== request.origin) return null;
    path = url.pathname;
  } catch {
    return null;
  }
  return path.startsWith(prefix) && /^[\w-]+$/.test(path.slice(prefix.length))
    ? path
    : null;
}

/**
 * 錯誤碼對應（protocol.md REST、T-120）：
 * - 409：WHIP 是房間還在 P2P（提示先切換），WHEP 是尚未開播，收看者維持 waiting。
 * - 401／403：WHEP 是被踢、被淘汰或登記時已被移除；WHIP 是房主身份失效或不是房主。
 */
function postError(role: RelayRole, status: number) {
  if (status === 409)
    return new TransportError(
      "STREAM_NOT_LIVE",
      role === "whip"
        ? "請先切換到轉發模式再發布。"
        : "目前沒有可收看的轉發直播",
    );
  if (status === 503)
    return new TransportError(
      "RELAY_UNAVAILABLE",
      "轉發模式目前無法使用，請房主改用「P2P 直連」。",
    );
  if (status === 401 || status === 403) {
    const message =
      role === "whep"
        ? "你已不在房間內，無法接收轉發。"
        : status === 401
          ? "房主身份已失效，請重新進入房間。"
          : "只有房主可以開始轉發。";
    return new TransportError("RELAY_FAILED", message);
  }
  return new TransportError(
    "RELAY_FAILED",
    role === "whip"
      ? `無法開始轉發（HTTP ${status}）`
      : `無法接收轉發（HTTP ${status}）`,
  );
}

/**
 * 送出單次 HTTP offer。不接受 AbortSignal：送出後一定等回應，
 * 拿到 `201` 才知道要 DELETE 哪個資源（§4：停止時若 POST 仍在途要等回應）。
 * 驗證完狀態碼與 `Location` 就 resolve，不等本文：停止時可以立刻 DELETE。
 */
export async function postOffer(
  roomId: string,
  role: RelayRole,
  token: string,
  sdp: string,
): Promise<RelayResource> {
  let response: Response;
  try {
    response = await fetch(relayUrl(roomId, role), {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        Authorization: `Bearer ${token}`,
      },
      body: sdp,
      cache: "no-store",
    });
  } catch (error) {
    throw new TransportError("RELAY_FAILED", "無法連到轉發服務", {
      cause: error,
    });
  }
  if (response.status !== 201) throw postError(role, response.status);
  const location = resourcePath(roomId, role, response.headers.get("Location"));
  if (!location) {
    void response.body?.cancel().catch(() => {});
    throw new TransportError("RELAY_FAILED", "轉發服務的回應缺少資源位置");
  }
  return { location, answer: response.text().catch(() => "") };
}

export type DeleteOutcome =
  /** 已刪除，或伺服器上已經沒有（403：找不到或不屬於自己；404：房間已不在）。 */
  | "deleted"
  /** 身份已失效（401），客戶端無法再清理，交給伺服器關房時處理。 */
  | "abandoned"
  /** 網路錯誤或伺服器暫時失敗，之後可以重試。 */
  | "failed";

async function deleteOnce(
  location: string,
  token: string,
): Promise<DeleteOutcome> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 不依賴 fetch 是否理會 abort：期限一到就結束這次嘗試。
  const timeout = new Promise<"failed">((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve("failed");
    }, DELETE_TIMEOUT_MS);
  });
  const attempt = (async (): Promise<DeleteOutcome> => {
    try {
      const response = await fetch(location, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        // 關分頁時 destroy() 送出的 DELETE 也要送得到。
        keepalive: true,
        signal: abort.signal,
      });
      if (response.ok || response.status === 403 || response.status === 404)
        return "deleted";
      if (response.status === 401) return "abandoned";
      return "failed";
    } catch {
      return "failed";
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * DELETE 資源，失敗時依 DELETE_RETRY_DELAYS_MS 重試。
 * 回應遺失後重試拿到 403，代表上一次其實已經刪掉（伺服器對不存在的資源回 403），
 * 視為完成。
 */
export async function deleteResource(
  location: string,
  token: string,
): Promise<DeleteOutcome> {
  let outcome = await deleteOnce(location, token);
  for (const delay of DELETE_RETRY_DELAYS_MS) {
    if (outcome !== "failed") return outcome;
    await wait(delay);
    outcome = await deleteOnce(location, token);
  }
  return outcome;
}
