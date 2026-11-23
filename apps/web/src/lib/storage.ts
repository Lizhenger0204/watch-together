// localStorage 在無痕模式或封鎖 cookie 時可能丟例外，一律包起來。

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 存不了就算了，只是下次要重新輸入
  }
}

/** 見 room-and-invite.md「Token」：key 為 room:<roomId>:token。 */
export const roomToken = {
  get: (roomId: string) => read(`room:${roomId}:token`),
  set: (roomId: string, token: string) => write(`room:${roomId}:token`, token),
  clear: (roomId: string) => write(`room:${roomId}:token`, null),
};

export const savedNickname = {
  get: () => read("nickname") ?? "",
  set: (nickname: string) => write("nickname", nickname),
};
