export const PROTOCOL_VERSION = 1;

/** 去掉易混淆的 0/O/1/I/L。見 docs/specs/room-and-invite.md。 */
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const INVITE_CODE_LENGTH = 8;

export const NICKNAME_MAX_LENGTH = 24;
export const JOIN_MAX_EXCLUDED_ROOMS = 16;
export const JOIN_MAX_BODY_BYTES = 2_048;
/** 加入冪等鍵：配置席位後多久內，同一把鍵重試會取回同一份結果（protocol.md「加入冪等」）。 */
export const JOIN_KEY_TTL_MS = 5 * 60_000;
export const TITLE_MAX_LENGTH = 200;
/** SDP 一般在數 KB 內，設上限避免惡意大訊息。 */
export const SDP_MAX_LENGTH = 64 * 1024;

/** WebSocket 連線後必須在此時間內完成驗證。 */
export const WS_AUTH_TIMEOUT_MS = 5_000;
export const WS_PING_INTERVAL_MS = 20_000;
/** 收看者回報 member:status 的間隔。 */
export const MEMBER_STATUS_INTERVAL_MS = 5_000;

/** 聊天訊息（protocol.md「聊天訊息」）：正規化後上限 200 字，原始輸入上限 1,000 字。 */
export const CHAT_MAX_LENGTH = 200;
export const CHAT_RAW_MAX_LENGTH = 1_000;
/** 聊天發言限流：每位成員每 10 秒最多 5 則。 */
export const CHAT_RATE_LIMIT_MAX = 5;
export const CHAT_RATE_LIMIT_WINDOW_MS = 10_000;
