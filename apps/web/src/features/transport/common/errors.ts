/** 傳輸層的錯誤碼（客戶端本地，與 REST 的 ErrorCode 無關）。 */
export type TransportErrorCode =
  | "ICE_UNAVAILABLE" // 取不到 ICE servers（fetch 失敗、逾時或格式錯誤）
  | "SIGNAL_ERROR" // 信令錯誤（收到格式不對、或送出失敗）
  | "PEER_FAILED" // 建立連線失敗（ICE failed、ICE restart 次數用盡）
  | "TRACK_ERROR" // 加 track、取編碼參數、setParameters 或 replaceTrack 失敗
  | "RELAY_FAILED" // WHIP / WHEP 其他失敗（轉發模式）
  | "STREAM_NOT_LIVE" // WHEP 回 409：房主還沒開播，收看者回到 waiting，不是致命錯誤
  | "RELAY_UNAVAILABLE"; // 轉發服務不可用（503）：UI 提示停用轉發選項

/** 傳輸層錯誤。`memberId` 只在房主端的多連線錯誤上有值。 */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly memberId?: string;

  constructor(
    code: TransportErrorCode,
    message: string,
    options?: { memberId?: string; cause?: unknown },
  ) {
    super(message, options);
    this.name = "TransportError";
    this.code = code;
    this.memberId = options?.memberId;
  }
}
