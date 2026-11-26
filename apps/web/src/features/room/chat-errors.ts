import { ApiError } from "../../lib/api";
import { SignalDisconnectedError, SignalTimeoutError } from "../../lib/signal";

export const CHAT_NOT_SENT = "連線中斷，訊息未送出。";
const UNCONFIRMED = "連線中斷，無法確認訊息是否已送出。";

/** 區分「確定沒送出」、「伺服器拒絕」與「已送出但結果不明」，避免使用者以為可以安全重送。 */
export function chatErrorMessage(error: unknown): string {
  if (error instanceof SignalDisconnectedError) {
    return error.inFlight ? UNCONFIRMED : CHAT_NOT_SENT;
  }
  if (error instanceof SignalTimeoutError) {
    return "伺服器沒有回應，無法確認訊息是否已送出。";
  }
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED") {
      return "發言太快了，請稍等幾秒再試。";
    }
    return error.message;
  }
  return "送出失敗，請稍後再試。";
}
