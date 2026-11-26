import type {
  CreateRoomResponse,
  JoinRoomResponse,
  RegenerateInviteCodeResponse,
  Role,
} from "@project/shared";
import type { Result } from "./errors";
import type { RelayResource } from "./relay";

// app.ts 透過這些介面使用房間功能，不直接碰 Durable Objects。
// 之後搬到 Node 只要提供另一份實作。

export type AuthedMember = { roomId: string; memberId: string; role: Role };

export interface RoomService {
  createRoom(nickname: string): Promise<CreateRoomResponse>;
  /** inviteCode 已正規化。 */
  joinRoom(
    inviteCode: string,
    nickname: string,
  ): Promise<Result<JoinRoomResponse>>;
  authenticate(
    roomId: string,
    token: string,
  ): Promise<Result<{ memberId: string; role: Role }>>;
  regenerateInviteCode(
    roomId: string,
    hostMemberId: string,
  ): Promise<Result<RegenerateInviteCodeResponse>>;
  leaveRoom(roomId: string, memberId: string): Promise<Result<null>>;
  ensureLegacySweep?(): Promise<void>;
  /**
   * WebSocket upgrade。roomId 未檢查格式：格式錯誤、房間不存在、已關閉或關房中，
   * 一律接受後以 4001（`room_closed`）關閉，回應完全相同。
   */
  connect(roomId: string, request: Request): Promise<Response>;
}

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
}

export interface RelayService {
  getPublication(roomId: string): Promise<RelayResource | null>;
  register(roomId: string, resource: RelayResource): Promise<Result<null>>;
  getResource(
    roomId: string,
    resourceId: string,
  ): Promise<RelayResource | null>;
  remove(roomId: string, resourceId: string): Promise<void>;
  /** 登記被拒、回滾也失敗的資源：記成清理待辦，之後重試關閉。 */
  retainForCleanup(roomId: string, resource: RelayResource): Promise<void>;
}

export type Services = {
  rooms: RoomService;
  relay: RelayService;
  joinLimiter: RateLimiter;
};
