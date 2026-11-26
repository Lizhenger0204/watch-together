import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import {
  liveIntent,
  resetMemoryStorage,
  roomInviteCode,
  roomToken,
} from "../../lib/storage";
import { performLeaveRoom } from "./use-leave-room";

describe("performLeaveRoom", () => {
  const shared = new Map<string, string>();
  const stubStorage = () => {
    vi.stubGlobal("localStorage", {
      get length() {
        return shared.size;
      },
      key: (i: number) => [...shared.keys()][i] ?? null,
      getItem: (k: string) => shared.get(k) ?? null,
      setItem: (k: string, v: string) => void shared.set(k, v),
      removeItem: (k: string) => void shared.delete(k),
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMemoryStorage();
    shared.clear();
  });

  test("直播中取消離開確認時，不送請求且保留身份", async () => {
    stubStorage();
    const roomId = crypto.randomUUID();
    roomToken.set(roomId, "host-token-1234567890");
    const requestLeave = vi.fn();
    const stop = vi.fn();
    const goHome = vi.fn();
    const setLeaving = vi.fn();
    const setError = vi.fn();

    const exited = await performLeaveRoom({
      roomId,
      token: "host-token-1234567890",
      client: { stop },
      isLiveHost: true,
      confirmLiveExit: () => false,
      requestLeave,
      goHome,
      setLeaving,
      setError,
    });

    expect(exited).toBe(false);
    expect(requestLeave).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(goHome).not.toHaveBeenCalled();
    expect(roomToken.get(roomId)).toBe("host-token-1234567890");
  });

  test("伺服器回 5xx 或網路錯誤時，保留身份與邀請碼並顯示錯誤", async () => {
    stubStorage();
    const roomId = crypto.randomUUID();
    roomToken.set(roomId, "member-token-12345678");
    roomInviteCode.set(roomId, "ABCDEFGH");
    const stop = vi.fn();
    const goHome = vi.fn();
    const leaving: boolean[] = [];
    const errors: string[] = [];

    const exited = await performLeaveRoom({
      roomId,
      token: "member-token-12345678",
      client: { stop },
      isLiveHost: false,
      requestLeave: async () => {
        throw new ApiError("INTERNAL");
      },
      goHome,
      setLeaving: (v) => leaving.push(v),
      setError: (e) => errors.push(e),
    });

    expect(exited).toBe(false);
    expect(leaving).toEqual([true, false]);
    expect(errors).toEqual(["", "伺服器出了點問題，請稍後再試。"]);
    expect(stop).not.toHaveBeenCalled();
    expect(goHome).not.toHaveBeenCalled();
    expect(roomToken.get(roomId)).toBe("member-token-12345678");
    expect(roomInviteCode.findRoom("ABCDEFGH")).toBe(roomId);
  });

  test("重試時伺服器回 UNAUTHORIZED（401），條件清除身份並返回首頁", async () => {
    stubStorage();
    const roomId = crypto.randomUUID();
    roomToken.set(roomId, "member-token-12345678");
    roomInviteCode.set(roomId, "ABCDEFGH");
    liveIntent.set(roomId, true);
    const stop = vi.fn();
    const goHome = vi.fn();

    const exited = await performLeaveRoom({
      roomId,
      token: "member-token-12345678",
      client: { stop },
      isLiveHost: false,
      requestLeave: async () => {
        throw new ApiError("UNAUTHORIZED");
      },
      goHome,
      setLeaving: vi.fn(),
      setError: vi.fn(),
    });

    expect(exited).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(goHome).toHaveBeenCalledOnce();
    expect(roomToken.get(roomId)).toBeNull();
    expect(roomInviteCode.findRoom("ABCDEFGH")).toBeNull();
    expect(liveIntent.get(roomId)).toBe(false);
  });

  test("退房途中另一分頁寫入新身份時，晚到的回應不清除新憑證與邀請對照", async () => {
    stubStorage();
    const roomId = crypto.randomUUID();
    const oldToken = "old-token-1234567890";
    const newToken = "new-token-1234567890";
    roomToken.set(roomId, oldToken);
    roomInviteCode.set(roomId, "ABCDEFGH");
    const stop = vi.fn();
    const goHome = vi.fn();

    const exited = await performLeaveRoom({
      roomId,
      token: oldToken,
      client: { stop },
      isLiveHost: false,
      requestLeave: async () => {
        shared.set(`room:${roomId}:token`, newToken);
        shared.set(`room:${roomId}:invite`, "ABCDEFGH");
      },
      goHome,
      setLeaving: vi.fn(),
      setError: vi.fn(),
    });

    expect(exited).toBe(true);
    expect(shared.get(`room:${roomId}:token`)).toBe(newToken);
    expect(shared.get(`room:${roomId}:invite`)).toBe("ABCDEFGH");
    expect(roomToken.get(roomId)).toBe(newToken);
  });
});
