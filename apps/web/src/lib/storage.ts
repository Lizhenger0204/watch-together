// 瀏覽器禁止儲存時，同一分頁仍可在記憶體保留身份。

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

// 比對上次看到的共用值，區分「這次寫入失敗留下的舊值」與「其他分頁之後寫的新值」。
const lastStoredIdentity = new Map<string, string | null>();

function storedIdentity(key: string) {
  try {
    return backend("local")?.getItem(key);
  } catch {
    return undefined;
  }
}

function readIdentity(key: string) {
  const stored = storedIdentity(key);
  const last = lastStoredIdentity.get(key) ?? null;
  if (stored !== undefined && stored !== last) {
    const current = memory.local.get(key);
    lastStoredIdentity.set(key, stored);
    // 只有本分頁沒有身份（沒讀過或已清除），或記憶體的值本來就來自共用儲存時，
    // 才採用其他分頁寫入的新值。本分頁寫入失敗、只存在記憶體的有效身份
    // （例如建房時存不進去的房主憑證）不可被覆蓋；它失效時由 clearIfCurrent 接手共用值。
    if (current === undefined || current === null || current === last) {
      memory.local.set(key, stored);
    }
  }
  return memory.local.get(key) ?? null;
}

function writeIdentity(key: string, value: string | null) {
  readIdentity(key);
  const saved = write("local", key, value);
  if (saved) lastStoredIdentity.set(key, value);
  return saved;
}

/** 見 room-and-invite.md「Token」：key 為 room:<roomId>:token。 */
export const roomToken = {
  get: (roomId: string) => readIdentity(tokenKey(roomId)),
  /** 回傳 false 代表只存在本分頁，重新整理後會遺失。 */
  set: (roomId: string, token: string) =>
    writeIdentity(tokenKey(roomId), token),
  /** token 是否真的寫進了 localStorage（否則重新整理就會遺失）。 */
  persisted(roomId: string) {
    const value = readIdentity(tokenKey(roomId));
    return value !== null && storedIdentity(tokenKey(roomId)) === value;
  },
  clear: (roomId: string) => {
    writeIdentity(tokenKey(roomId), null);
    writeIdentity(inviteKey(roomId), null);
    write("session", liveIntentKey(roomId), null);
  },
  clearIfCurrent(roomId: string, token: string) {
    const key = tokenKey(roomId);
    if (readIdentity(key) !== token) return;
    const stored = storedIdentity(key);
    if (stored && stored !== token) {
      // 失效的身份只寫進記憶體時，共用儲存裡可能還有另一份憑證。
      lastStoredIdentity.set(key, stored);
      memory.local.set(key, stored);
      return;
    }
    roomToken.clear(roomId);
  },
};

/**
 * 房主看到的邀請碼（只用來在房主開自己的邀請連結時認出是哪一房）。
 * 不是機密：邀請碼本來就要傳給朋友。
 */
export const roomInviteCode = {
  set: (roomId: string, inviteCode: string) =>
    writeIdentity(inviteKey(roomId), inviteCode),
  findRoom(inviteCode: string): string | null {
    for (const key of keys("local")) {
      const match = /^room:(.+):invite$/.exec(key);
      if (match?.[1] && readIdentity(key) === inviteCode) return match[1];
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
  lastStoredIdentity.clear();
  memory.local.clear();
  memory.session.clear();
}
