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
  /** 列出持有憑證的房號：共用儲存與本分頁記憶體（例如存不進去的房主憑證）都算。 */
  rooms(): string[] {
    const ids: string[] = [];
    for (const key of keys("local")) {
      const id = /^room:(.+):token$/.exec(key)?.[1];
      if (id && readIdentity(key) !== null) ids.push(id);
    }
    return ids;
  },
  clear: (roomId: string) => {
    writeIdentity(tokenKey(roomId), null);
    writeIdentity(inviteKey(roomId), null);
    write("session", liveIntentKey(roomId), null);
    write("local", liveStopKey(roomId), null);
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

const joinKeyKey = (inviteCode: string) => `join:${inviteCode}:key`;

// 只放「寫入共用儲存失敗」的本分頁待完成鍵，避免共用儲存已被別的分頁清空後又讀回舊值。
const pendingJoinMemory = new Map<string, string>();
// 刪除共用儲存失敗時記住確切的舊原值：略過那筆刪不掉的舊值，但其他分頁寫新值仍讀得到。
const tombstonedJoinKeys = new Set<string>();

function parseJoinKeyEntry(raw: string | null | undefined) {
  const match = raw && /^(\d+):(.+)$/.exec(raw);
  if (!match) return null;
  return { createdAt: Number(match[1]), key: match[2]! };
}

function readStoredJoinKey(storageKey: string): string | null {
  const stored = storedIdentity(storageKey);
  if (!stored || tombstonedJoinKeys.has(`${storageKey}\0${stored}`)) {
    return null;
  }
  return stored;
}

function removeStoredJoinKey(storageKey: string, expectedRaw: string) {
  try {
    const store = backend("local");
    if (!store || store.getItem(storageKey) !== expectedRaw) return;
    store.removeItem(storageKey);
  } catch {
    tombstonedJoinKeys.add(`${storageKey}\0${expectedRaw}`);
  }
}

/**
 * 尚未確認結果的加入冪等鍵（protocol.md「加入冪等」、room-and-invite.md）。
 * 存在共用儲存，接手加入鎖的其他分頁讀得到；值為 `<建立時間>:<鍵>`。
 * 持久儲存與本分頁記憶體分開核對，寫入失敗後的清理絕不會誤刪其他分頁寫入的新鍵。
 * 機密，與 token 同等對待：不可寫進 log、URL 或畫面。
 */
export const pendingJoinKey = {
  /** 期限內的鍵；沒有或已超過 ttlMs 就清理並回 null。 */
  get(inviteCode: string, ttlMs: number, now = Date.now()) {
    const storageKey = joinKeyKey(inviteCode);
    const stored = readStoredJoinKey(storageKey);
    if (stored !== null) {
      const parsed = parseJoinKeyEntry(stored);
      if (parsed && now - parsed.createdAt < ttlMs) return parsed.key;
      removeStoredJoinKey(storageKey, stored);
    }
    const mem = pendingJoinMemory.get(storageKey);
    if (mem !== undefined) {
      const parsed = parseJoinKeyEntry(mem);
      if (parsed && now - parsed.createdAt < ttlMs) return parsed.key;
      pendingJoinMemory.delete(storageKey);
    }
    return null;
  },
  /** 這把鍵目前是否真的存在於共用儲存（而非只留在本分頁記憶體）。 */
  persisted(inviteCode: string, key: string) {
    const stored = readStoredJoinKey(joinKeyKey(inviteCode));
    return parseJoinKeyEntry(stored)?.key === key;
  },
  /** 回傳 false 代表寫入共用儲存失敗，只保留在本分頁記憶體。 */
  set(inviteCode: string, key: string, now = Date.now()) {
    const storageKey = joinKeyKey(inviteCode);
    const raw = `${now}:${key}`;
    try {
      const store = backend("local");
      if (store) {
        store.setItem(storageKey, raw);
        pendingJoinMemory.delete(storageKey);
        tombstonedJoinKeys.delete(`${storageKey}\0${raw}`);
        return true;
      }
    } catch {
      // 寫入失敗，退回本分頁記憶體
    }
    pendingJoinMemory.set(storageKey, raw);
    return false;
  },
  /** 分別核對持久值與記憶體值，只刪除各自與 key 相符的那份。 */
  clearIfCurrent(inviteCode: string, key: string) {
    const storageKey = joinKeyKey(inviteCode);
    if (parseJoinKeyEntry(pendingJoinMemory.get(storageKey))?.key === key) {
      pendingJoinMemory.delete(storageKey);
    }
    const stored = readStoredJoinKey(storageKey);
    if (stored !== null && parseJoinKeyEntry(stored)?.key === key) {
      removeStoredJoinKey(storageKey, stored);
    }
  },
  /** 清除所有邀請碼已逾期或格式損壞的待完成鍵，避免儲存項累積。 */
  prune(ttlMs: number, now = Date.now()) {
    for (const [storageKey, raw] of pendingJoinMemory) {
      const parsed = parseJoinKeyEntry(raw);
      if (!parsed || now - parsed.createdAt >= ttlMs) {
        pendingJoinMemory.delete(storageKey);
      }
    }
    for (const storageKey of keys("local")) {
      if (!/^join:.+:key$/.test(storageKey)) continue;
      const stored = readStoredJoinKey(storageKey);
      if (stored === null) continue;
      const parsed = parseJoinKeyEntry(stored);
      if (!parsed || now - parsed.createdAt >= ttlMs) {
        removeStoredJoinKey(storageKey, stored);
      }
    }
  },
};

const liveIntentKey = (roomId: string) => `room:${roomId}:live`;
const liveStopKey = (roomId: string) => `room:${roomId}:stopped`;

/** 最後一次明確停播的標記（共用儲存，每次重讀才看得到其他分頁剛寫的值）。 */
function stopMarker(roomId: string) {
  const key = liveStopKey(roomId);
  try {
    const stored = backend("local")?.getItem(key);
    if (stored != null) return stored;
  } catch {
    // 讀不到就只看記憶體
  }
  return memory.local.get(key) ?? "";
}

/**
 * 房主「想要開播」的意圖，只存在這個分頁（重新整理後保留、關分頁就沒了）。
 * 值記著設定當時的停播標記：之後任何分頁明確停播（stopEverywhere）就失效，
 * 被取代或斷線的舊分頁回來時不會自動開播。
 */
export const liveIntent = {
  get: (roomId: string) =>
    read("session", liveIntentKey(roomId)) === `1:${stopMarker(roomId)}`,
  set: (roomId: string, on: boolean) =>
    write(
      "session",
      liveIntentKey(roomId),
      on ? `1:${stopMarker(roomId)}` : null,
    ),
  /** 房主明確按「停止直播」：其他分頁保存的開播意圖一併失效。 */
  stopEverywhere(roomId: string) {
    const marker = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    write("local", liveStopKey(roomId), marker);
    write("session", liveIntentKey(roomId), null);
  },
};

export const savedNickname = {
  get: () => read("local", "nickname") ?? "",
  set: (nickname: string) => write("local", "nickname", nickname),
};

/** 測試用：清空分頁記憶體。 */
export function resetMemoryStorage() {
  lastStoredIdentity.clear();
  pendingJoinMemory.clear();
  tombstonedJoinKeys.clear();
  memory.local.clear();
  memory.session.clear();
}
