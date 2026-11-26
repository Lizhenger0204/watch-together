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
    writeIdentity(key, null);
    // 清除邀請碼對照前再次核對共用 token，避免刪除另一分頁剛寫入的新憑證對照。
    const afterToken = storedIdentity(key);
    if (afterToken && afterToken !== token) {
      lastStoredIdentity.set(key, afterToken);
      memory.local.set(key, afterToken);
      return;
    }
    writeIdentity(inviteKey(roomId), null);
    write("session", liveIntentKey(roomId), null);
    write("local", liveStopKey(roomId), null);
  },
};

function parseStoredInvite(raw: string | null | undefined) {
  const match = raw && /^([A-Za-z0-9]+)(?::(\d+))?$/.exec(raw);
  if (!match) return null;
  return {
    inviteCode: match[1]!,
    version: match[2] !== undefined ? Number(match[2]) : null,
  };
}

function readRawInvite(roomId: string): string | null {
  const key = inviteKey(roomId);
  const stored = storedIdentity(key);
  if (stored !== undefined && stored !== null) return stored;
  return memory.local.get(key) ?? null;
}

/**
 * 房間邀請碼對照（用來在開邀請連結時認出是哪一房，以及在同源分頁間依版本同步最新邀請碼）。
 * 不是機密：邀請碼本來就要傳給朋友。
 * 房主寫入格式為 `<邀請碼>:<版本>`；收看者或舊資料為 `<邀請碼>`。
 */
export const roomInviteCode = {
  /** 讀取目前對照原值（供請求前拍照，避免晚到的無版本回應覆寫請求期間已更新的對照）。 */
  readRaw: (roomId: string) => readRawInvite(roomId),
  /** 拍下所有房間目前的邀請碼對照原值（給送出前還不知道房號的加入請求用）。 */
  snapshot(): Map<string, string | null> {
    const snap = new Map<string, string | null>();
    for (const key of keys("local")) {
      const match = /^room:(.+):invite$/.exec(key);
      if (match?.[1]) snap.set(match[1], readRawInvite(match[1]));
    }
    return snap;
  },
  set: (roomId: string, inviteCode: string) => {
    const key = inviteKey(roomId);
    const current = parseStoredInvite(readIdentity(key));
    // 同一組碼已有版本號時保留原版本，避免無版本寫入抹掉房主版本。
    if (current?.inviteCode === inviteCode && current.version !== null) {
      return storedIdentity(key) === `${inviteCode}:${current.version}`;
    }
    return writeIdentity(key, inviteCode);
  },
  /**
   * 只有請求期間對照沒有被其他分頁改寫時才寫入無版本邀請碼；
   * 若另一分頁已在途中換碼並寫入新版對照，保留該對照、不倒退覆寫。
   */
  setIfUnchanged(
    roomId: string,
    inviteCode: string,
    expectedRaw: string | null,
  ) {
    const key = inviteKey(roomId);
    const currentRaw = readRawInvite(roomId);
    if (currentRaw !== expectedRaw) {
      const stored = storedIdentity(key);
      if (stored !== undefined && stored !== null) {
        memory.local.set(key, stored);
        lastStoredIdentity.set(key, stored);
      }
      return false;
    }
    return roomInviteCode.set(roomId, inviteCode);
  },
  /**
   * 房主依單調遞增的 inviteCodeVersion 同步共用儲存：
   * 若另一同源分頁已寫入更新版本，保留該版本並回傳，不倒退覆蓋。
   */
  sync(
    roomId: string,
    inviteCode: string,
    version: number,
  ): { inviteCode: string; version: number } {
    const key = inviteKey(roomId);
    const stored = parseStoredInvite(storedIdentity(key));
    const mem = parseStoredInvite(memory.local.get(key));
    const current =
      stored?.version !== undefined &&
      stored.version !== null &&
      (mem?.version === undefined ||
        mem.version === null ||
        stored.version >= mem.version)
        ? stored
        : mem;
    if (current && current.version !== null && current.version > version) {
      const raw = `${current.inviteCode}:${current.version}`;
      memory.local.set(key, raw);
      if (stored?.version === current.version) lastStoredIdentity.set(key, raw);
      return { inviteCode: current.inviteCode, version: current.version };
    }
    writeIdentity(key, `${inviteCode}:${version}`);
    return { inviteCode, version };
  },
  /** 監聽其他同源分頁寫入的較新邀請碼版本。 */
  subscribe(
    roomId: string,
    onUpdate: (latest: { inviteCode: string; version: number }) => void,
  ) {
    if (typeof globalThis.addEventListener !== "function") return () => {};
    const key = inviteKey(roomId);
    const listener = (event: Event) => {
      const storageEvent = event as StorageEvent;
      if (storageEvent.key !== key || !storageEvent.newValue) return;
      const parsed = parseStoredInvite(storageEvent.newValue);
      if (!parsed || parsed.version === null) return;
      memory.local.set(key, storageEvent.newValue);
      lastStoredIdentity.set(key, storageEvent.newValue);
      onUpdate({ inviteCode: parsed.inviteCode, version: parsed.version });
    };
    globalThis.addEventListener("storage", listener);
    return () => globalThis.removeEventListener("storage", listener);
  },
  findRoom(inviteCode: string): string | null {
    for (const key of keys("local")) {
      const match = /^room:(.+):invite$/.exec(key);
      if (
        match?.[1] &&
        parseStoredInvite(readIdentity(key))?.inviteCode === inviteCode
      )
        return match[1];
    }
    return null;
  },
};

const joinKeyKey = (inviteCode: string) => `join:${inviteCode}:key`;

// 只放「寫入共用儲存失敗」的本分頁待完成鍵，避免共用儲存已被別的分頁清空後又讀回舊值。
const pendingJoinMemory = new Map<string, string>();
// 刪除共用儲存失敗時記住確切的舊原值：略過那筆刪不掉的舊值，但其他分頁寫新值仍讀得到，
// 且 prune() 會比對持久原值重試刪除，成功或發現新值後淘汰墓碑。
const tombstonedJoinKeys = new Map<string, string>();

function parseJoinKeyEntry(raw: string | null | undefined) {
  const match = raw && /^(\d+):(.+)$/.exec(raw);
  if (!match) return null;
  return { createdAt: Number(match[1]), key: match[2]! };
}

function readStoredJoinKey(storageKey: string): string | null {
  const stored = storedIdentity(storageKey);
  if (stored === undefined) return null;
  const tomb = tombstonedJoinKeys.get(storageKey);
  if (tomb !== undefined) {
    if (stored === tomb) return null;
    // 持久儲存已被清空或換成其他分頁的新值，對應墓碑已過時。
    tombstonedJoinKeys.delete(storageKey);
  }
  return stored;
}

function removeStoredJoinKey(storageKey: string, expectedRaw: string) {
  try {
    const store = backend("local");
    if (!store) return;
    if (store.getItem(storageKey) !== expectedRaw) {
      if (tombstonedJoinKeys.get(storageKey) === expectedRaw) {
        tombstonedJoinKeys.delete(storageKey);
      }
      return;
    }
    store.removeItem(storageKey);
    if (tombstonedJoinKeys.get(storageKey) === expectedRaw) {
      tombstonedJoinKeys.delete(storageKey);
    }
  } catch {
    tombstonedJoinKeys.set(storageKey, expectedRaw);
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
        tombstonedJoinKeys.delete(storageKey);
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
  /** 補刪先前刪除失敗的墓碑舊值，並清除所有邀請碼已逾期或格式損壞的待完成鍵。 */
  prune(ttlMs: number, now = Date.now()) {
    for (const [storageKey, raw] of pendingJoinMemory) {
      const parsed = parseJoinKeyEntry(raw);
      if (!parsed || now - parsed.createdAt >= ttlMs) {
        pendingJoinMemory.delete(storageKey);
      }
    }
    // 先重試清理因暫時性刪除失敗而留下的舊值（仍是原值才刪，避免誤刪新值）。
    for (const [storageKey, expectedRaw] of [...tombstonedJoinKeys]) {
      removeStoredJoinKey(storageKey, expectedRaw);
    }
    for (const storageKey of keys("local")) {
      if (!/^join:.+:key$/.test(storageKey)) continue;
      const stored = storedIdentity(storageKey);
      if (!stored) continue;
      if (tombstonedJoinKeys.get(storageKey) === stored) {
        removeStoredJoinKey(storageKey, stored);
        continue;
      }
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
