import type { RelayEnv } from "../../relay";
import type { TurnEnv } from "../../ice";
import type { InviteDirectoryDO } from "./invite-directory-do";
import type { RoomDO } from "./room-do";

export interface Env extends TurnEnv, RelayEnv {
  ROOM: DurableObjectNamespace<RoomDO>;
  INVITE_DIRECTORY: DurableObjectNamespace<InviteDirectoryDO>;
  /** 正式環境必須設定；沒有或出錯時改用記憶體後備限流（見 room-and-invite.md）。 */
  JOIN_RATE_LIMITER?: RateLimit;
  ROOM_MAX_MEMBERS?: string | number;
  ROOM_IDLE_TTL_MS?: string | number;
  ROOM_HOST_OFFLINE_TTL_MS?: string | number;
  ROOM_MAX_AGE_MS?: string | number;
}

/** 邀請碼對照只有一個實例。 */
export const INVITE_DIRECTORY_NAME = "global";
