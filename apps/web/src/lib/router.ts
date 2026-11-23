import { useSyncExternalStore } from "react";

// 只有三個頁面，用 History API 就夠了，不另外引入路由套件。

export type Route =
  | { page: "home" }
  | { page: "join"; inviteCode: string }
  | { page: "room"; roomId: string }
  | { page: "not-found" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { page: "home" };
  const join = /^\/join\/([^/]+)\/?$/.exec(pathname);
  if (join?.[1])
    return { page: "join", inviteCode: decodeURIComponent(join[1]) };
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

export function navigate(path: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  listeners.forEach((listener) => listener());
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export const roomPath = (roomId: string) => `/rooms/${roomId}`;
export const joinUrl = (inviteCode: string) =>
  `${location.origin}/join/${inviteCode}`;
