import { useSyncExternalStore } from "react";

// 只有三個頁面，用 History API 就夠了，不另外引入路由套件。

export type Route =
  | { page: "home" }
  | { page: "join"; inviteCode: string }
  | { page: "room"; roomId: string }
  | { page: "not-found" };

/** 截斷的百分比編碼會讓 decodeURIComponent 丟 URIError；原樣交給加入表單去提示格式錯誤。 */
function safeDecode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { page: "home" };
  const join = /^\/join\/([^/]+)\/?$/.exec(pathname);
  if (join?.[1]) return { page: "join", inviteCode: safeDecode(join[1]) };
  const room = /^\/rooms\/([0-9a-f-]{36})\/?$/.exec(pathname);
  if (room?.[1]) return { page: "room", roomId: room[1] };
  return { page: "not-found" };
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export type NavigationState = { notice?: string };

export function navigate(
  path: string,
  { replace = false, notice }: { replace?: boolean; notice?: string } = {},
) {
  const state: NavigationState | null = notice ? { notice } : null;
  if (replace) history.replaceState(state, "", path);
  else history.pushState(state, "", path);
  listeners.forEach((listener) => listener());
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export const roomPath = (roomId: string) => `/rooms/${roomId}`;
export const joinUrl = (inviteCode: string) =>
  `${location.origin}/join/${inviteCode}`;

/** 上一頁透過 navigate({ notice }) 留下的提示（例如被踢出後回首頁）。 */
export function readNotice(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const notice = (state as NavigationState).notice;
  return typeof notice === "string" && notice ? notice : null;
}
