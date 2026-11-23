import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { JOIN_RATE_LIMIT, createMemoryRateLimiter } from "../../rate-limit";
import type { Services } from "../../services";
import { isRoomId } from "../../room/crypto";
import { INVITE_DIRECTORY_NAME, type Env } from "./env";
import { roomClosedSocket } from "./room-closed-socket";

// 後備限流器跨請求共用（同一個 isolate 內），所以放在模組層級。
const fallbackJoinLimiter = createMemoryRateLimiter(JOIN_RATE_LIMIT);
let warnedMissingLimiter = false;

export function workersServices(c: Context<AppEnv>): Services {
  const env = c.env as unknown as Env;
  const directory = () => env.INVITE_DIRECTORY.getByName(INVITE_DIRECTORY_NAME);
  const room = (roomId: string) => env.ROOM.getByName(roomId);

  return {
    rooms: {
      async createRoom(nickname) {
        const roomId = crypto.randomUUID();
        const inviteCode = await directory().reserve(roomId);
        const { hostToken, memberId } = await room(roomId).init({
          roomId,
          inviteCode,
          nickname,
        });
        return { roomId, inviteCode, hostToken, memberId };
      },
      async joinRoom(inviteCode, nickname) {
        const roomId = await directory().lookup(inviteCode);
        if (!roomId) return { ok: false, code: "ROOM_NOT_FOUND" };
        const result = await room(roomId).join({ inviteCode, nickname });
        return result.ok
          ? { ok: true, value: { roomId, ...result.value } }
          : result;
      },
      authenticate: (roomId, token) => room(roomId).authenticate(token),
      regenerateInviteCode: (roomId, hostMemberId) =>
        room(roomId).regenerateInviteCode(hostMemberId),
      // 格式錯誤的 roomId 不建 DO，回應與不存在的房間相同。
      connect: async (roomId, request) =>
        isRoomId(roomId) ? room(roomId).fetch(request) : roomClosedSocket(),
    },
    relay: {
      getPublication: (roomId) => room(roomId).getRelayPublication(),
      register: (roomId, resource) =>
        room(roomId).registerRelayResource(resource),
      getResource: (roomId, id) => room(roomId).getRelayResource(id),
      remove: (roomId, id) => room(roomId).removeRelayResource(id),
      retainForCleanup: (roomId, resource) =>
        room(roomId).retainRelayCleanup(resource),
    },
    joinLimiter: {
      async allow(key) {
        const binding = env.JOIN_RATE_LIMITER;
        if (!binding) {
          if (!warnedMissingLimiter) {
            warnedMissingLimiter = true;
            console.log(
              JSON.stringify({
                event: "ratelimit.fallback",
                reason: "not_configured",
              }),
            );
          }
          return fallbackJoinLimiter.allow(key);
        }
        try {
          return (await binding.limit({ key })).success;
        } catch {
          console.log(
            JSON.stringify({
              event: "ratelimit.fallback",
              reason: "binding_error",
            }),
          );
          return fallbackJoinLimiter.allow(key);
        }
      },
    },
  };
}
