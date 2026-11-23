export const PROTOCOL_VERSION = 1;

/** 去掉易混淆的 0/O/1/I/L。見 docs/specs/room-and-invite.md。 */
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const INVITE_CODE_LENGTH = 8;

export const NICKNAME_MAX_LENGTH = 24;
export const TITLE_MAX_LENGTH = 200;
/** SDP 一般在數 KB 內，設上限避免惡意大訊息。 */
export const SDP_MAX_LENGTH = 64 * 1024;

/** WebSocket 連線後必須在此時間內送出 auth。 */
export const WS_AUTH_TIMEOUT_MS = 5_000;
export const WS_PING_INTERVAL_MS = 20_000;
/** 收看者回報 member:status 的間隔。 */
export const MEMBER_STATUS_INTERVAL_MS = 5_000;
