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

export type RelayResource = { answer: string; location: string };

export function relayUrl(roomId: string, role: RelayRole) {
  return `/api/rooms/${encodeURIComponent(roomId)}/${role}`;
}

/**
 * 只接受同一房間的資源路徑。Location 來自伺服器回應，若不檢查就照著 DELETE，
 * 被竄改的回應可能讓 token 被送到別的網址。
 */
function resourcePath(roomId: string, location: string | null) {
  if (!location) return null;
  const prefix = `/api/rooms/${encodeURIComponent(roomId)}/relay/`;
  let path: string;
  try {
    const url = new URL(location, "http://same-origin.invalid");
    if (url.origin !== "http://same-origin.invalid") return null;
    path = url.pathname;
  } catch {
    return null;
  }
  return path.startsWith(prefix) && /^[\w-]+$/.test(path.slice(prefix.length))
    ? path
    : null;
}

function postError(role: RelayRole, status: number) {
  if (status === 409)
    return new TransportError("STREAM_NOT_LIVE", "房主尚未開播");
  if (status === 503)
    return new TransportError(
      "RELAY_UNAVAILABLE",
      "轉發模式目前無法使用，請房主改用「P2P 直連」。",
    );
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
  const location = resourcePath(roomId, response.headers.get("Location"));
  const answer = await response.text().catch(() => "");
  if (!location) {
    throw new TransportError("RELAY_FAILED", "轉發服務的回應缺少資源位置");
  }
  return { answer, location };
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
  try {
    const response = await fetch(location, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      // 關分頁時 destroy() 送出的 DELETE 也要送得到。
      keepalive: true,
    });
    if (response.ok || response.status === 403 || response.status === 404)
      return "deleted";
    if (response.status === 401) return "abandoned";
    return "failed";
  } catch {
    return "failed";
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
