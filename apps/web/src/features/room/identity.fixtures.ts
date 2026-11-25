import { expect, vi } from "vitest";

// identity 測試共用的替身。真正的 describe／test 在 identity*.test.ts。

export const ROOM = crypto.randomUUID();
export const OTHER = crypto.randomUUID();
export const TOKEN = crypto.randomUUID();
export const NEW_TOKEN = crypto.randomUUID();
export const CODE = "ABCDEFGH";
export const ROTATED = "XYZW2345";

export function mockApi({
  locked = false,
  revoked = false,
  full = false,
} = {}) {
  let code = CODE;
  let activeToken: string | null = revoked ? null : TOKEN;
  let nextToken = revoked ? NEW_TOKEN : TOKEN;
  let admissions = 0;
  let iceStatus = 200;
  const fail = (status: number, code: string) =>
    Response.json({ error: { code, message: "測試錯誤" } }, { status });
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    if (String(path).endsWith("/ice")) {
      if (!iceStatus) throw new TypeError("offline");
      if (
        iceStatus === 200 &&
        String(path) === `/api/rooms/${ROOM}/ice` &&
        auth !== "Bearer " + activeToken
      )
        return fail(401, "UNAUTHORIZED");
      return iceStatus === 200
        ? Response.json({ iceServers: [] })
        : fail(
            iceStatus,
            iceStatus === 401
              ? "UNAUTHORIZED"
              : iceStatus === 404
                ? "ROOM_NOT_FOUND"
                : "INTERNAL",
          );
    }
    expect(path).toBe("/api/rooms/join");
    const body: {
      inviteCode: string;
      existingRoomId?: string;
      excludeRoomIds?: string[];
    } = JSON.parse(String(init?.body));
    const result = (memberToken: string) =>
      Response.json({ roomId: ROOM, memberId: "member", memberToken });
    if (body.inviteCode !== code) return fail(404, "ROOM_NOT_FOUND");
    if (
      auth === "Bearer " + activeToken &&
      body.existingRoomId === ROOM &&
      activeToken
    )
      return Response.json({ roomId: ROOM, memberId: "member", reused: true });
    if (full && !body.existingRoomId && !locked) return fail(409, "ROOM_FULL");
    if (
      body.existingRoomId ||
      auth ||
      body.excludeRoomIds?.includes(ROOM) ||
      locked
    )
      return fail(404, "ROOM_NOT_FOUND");
    admissions++;
    activeToken = nextToken;
    nextToken = activeToken === TOKEN ? NEW_TOKEN : crypto.randomUUID();
    return result(activeToken);
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    admissions: () => admissions,
    evict: () => {
      activeToken = null;
    },
    rotate: () => {
      code = ROTATED;
    },
    ice: (status: number) => {
      iceStatus = status;
    },
  };
}

export function persistedTokens(entries: [string, string][]) {
  const values = new Map(
    entries.map(([id, token]) => [`room:${id}:token`, token]),
  );
  vi.stubGlobal("localStorage", {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
}
