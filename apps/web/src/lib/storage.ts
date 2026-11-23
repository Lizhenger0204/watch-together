// 身份先存在分頁記憶體，再嘗試寫入瀏覽器儲存空間；讀取時記憶體優先。
// localStorage 在無痕模式或封鎖網站資料時可能丟例外或寫不進去，
// 這時至少同一分頁不會失去身份（重新整理才會遺失）。

type Backend = "local" | "session";

function backend(kind: Backend): Storage | null {
  try {
    return kind === "local"
      ? globalThis.localStorage
      : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

/** null 代表「已清除」，避免沒刪掉的舊值從瀏覽器儲存空間又冒出來。 */
const memory: Record<Backend, Map<string, string | null>> = {
  local: new Map(),
  session: new Map(),
};

function read(kind: Backend, key: string) {
  const cached = memory[kind].get(key);
  if (cached !== undefined) return cached;
  try {
    return backend(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 回傳是否成功寫入瀏覽器儲存空間（記憶體一定會寫）。 */
function write(kind: Backend, key: string, value: string | null) {
  memory[kind].set(key, value);
  try {
    const store = backend(kind);
    if (!store) return false;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function keys(kind: Backend) {
  const result = new Set(memory[kind].keys());
  try {
    const store = backend(kind);
    for (let i = 0; store && i < store.length; i++) {
      const key = store.key(i);
      if (key !== null) result.add(key);
    }
  } catch {
    // 讀不到就只看記憶體
  }
  return result;
}

const tokenKey = (roomId: string) => `room:${roomId}:token`;
const inviteKey = (roomId: string) => `room:${roomId}:invite`;

/** 見 room-and-invite.md「Token」：key 為 room:<roomId>:token。 */
export const roomToken = {
  get: (roomId: string) => read("local", tokenKey(roomId)),
  /** 回傳 false 代表只存在本分頁，重新整理後會遺失。 */
  set: (roomId: string, token: string) =>
    write("local", tokenKey(roomId), token),
  /** token 是否真的寫進了 localStorage（否則重新整理就會遺失）。 */
  persisted(roomId: string) {
    const value = read("local", tokenKey(roomId));
    try {
      return (
        value !== null && backend("local")?.getItem(tokenKey(roomId)) === value
      );
    } catch {
      return false;
    }
  },
  clear: (roomId: string) => {
    write("local", tokenKey(roomId), null);
    write("local", inviteKey(roomId), null);
    write("session", liveIntentKey(roomId), null);
  },
};

/**
 * 房主看到的邀請碼（只用來在房主開自己的邀請連結時認出是哪一房）。
 * 不是機密：邀請碼本來就要傳給朋友。
 */
export const roomInviteCode = {
  set: (roomId: string, inviteCode: string) =>
    write("local", inviteKey(roomId), inviteCode),
  findRoom(inviteCode: string): string | null {
    for (const key of keys("local")) {
      const match = /^room:(.+):invite$/.exec(key);
      if (match?.[1] && read("local", key) === inviteCode) return match[1];
    }
    return null;
  },
};

const liveIntentKey = (roomId: string) => `room:${roomId}:live`;

/** 房主「想要開播」的意圖，只存在這個分頁（重新整理後保留、關分頁就沒了）。 */
export const liveIntent = {
  get: (roomId: string) => read("session", liveIntentKey(roomId)) === "1",
  set: (roomId: string, on: boolean) =>
    write("session", liveIntentKey(roomId), on ? "1" : null),
};

export const savedNickname = {
  get: () => read("local", "nickname") ?? "",
  set: (nickname: string) => write("local", "nickname", nickname),
};

/** 測試用：清空分頁記憶體。 */
export function resetMemoryStorage() {
  memory.local.clear();
  memory.session.clear();
}
