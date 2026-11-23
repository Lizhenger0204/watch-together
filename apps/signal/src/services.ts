import type {
  CreateRoomResponse,
  JoinRoomResponse,
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
  ): Promise<Result<{ inviteCode: string }>>;
  /** WebSocket upgrade。 */
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
}

export type Services = {
  rooms: RoomService;
  relay: RelayService;
  joinLimiter: RateLimiter;
};
