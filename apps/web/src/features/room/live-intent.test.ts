import { TITLE_MAX_LENGTH, type StreamInfo } from "@project/shared";
import { describe, expect, test } from "vitest";
import {
  afterStreamCommandFailed,
  nextStreamCommand,
  streamTitle,
  type StreamCommandInput,
} from "./live-intent";

const off: StreamInfo = { live: false, title: null, startedAt: null };
const on = (title: string): StreamInfo => ({ live: true, title, startedAt: 1 });

function input(patch: Partial<StreamCommandInput> = {}): StreamCommandInput {
  return {
    intent: true,
    connected: true,
    session: 1,
    stream: off,
    source: { ready: true, title: "電影" },
    lastSent: null,
    ...patch,
  };
}

describe("nextStreamCommand（房主重新連線後恢復直播）", () => {
  test("重新驗證後 snapshot 是未開播、意圖還在、片源可用：自動再送一次開播", () => {
    expect(nextStreamCommand(input({ session: 2 }))).toEqual({
      live: true,
      title: "電影",
    });
  });

  test("同一次連線已經送過、還沒收到廣播：不重送", () => {
    expect(
      nextStreamCommand(
        input({
          lastSent: { session: 1, command: { live: true, title: "電影" } },
        }),
      ),
    ).toBeNull();
  });

  test("新的連線（session 變了）即使上次送過也要再送", () => {
    expect(
      nextStreamCommand(
        input({
          session: 2,
          lastSent: { session: 1, command: { live: true, title: "電影" } },
        }),
      ),
    ).toEqual({ live: true, title: "電影" });
  });

  test("伺服器狀態已經符合意圖：什麼都不送", () => {
    expect(nextStreamCommand(input({ stream: on("電影") }))).toBeNull();
    expect(nextStreamCommand(input({ intent: false, stream: off }))).toBeNull();
  });

  test("未連上（還沒收到 snapshot）時不送", () => {
    expect(nextStreamCommand(input({ connected: false }))).toBeNull();
  });

  test("房主按停止（意圖清除）而伺服器還在直播：送停播", () => {
    expect(
      nextStreamCommand(input({ intent: false, stream: on("電影") })),
    ).toEqual({ live: false, title: null });
  });

  test("直播中換成還在檢查／待確認的影片：先停播，不要繼續顯示舊片", () => {
    expect(
      nextStreamCommand(
        input({
          stream: on("舊片"),
          source: { ready: false, title: "新片" },
        }),
      ),
    ).toEqual({ live: false, title: null });
  });

  test("新片確認後依意圖恢復，並帶新片名", () => {
    expect(
      nextStreamCommand(
        input({
          stream: off,
          source: { ready: true, title: "新片" },
          lastSent: { session: 1, command: { live: false, title: null } },
        }),
      ),
    ).toEqual({ live: true, title: "新片" });
  });

  test("直播中片名不同（換片後已可用）：更新片名", () => {
    expect(
      nextStreamCommand(
        input({ stream: on("舊片"), source: { ready: true, title: "新片" } }),
      ),
    ).toEqual({ live: true, title: "新片" });
  });

  test("片名超過上限：送出截斷後的片名，且不會因為和伺服器片名不同而反覆重送", () => {
    const long = "a".repeat(TITLE_MAX_LENGTH + 1);
    const command = nextStreamCommand(
      input({ source: { ready: true, title: long } }),
    );
    expect(command?.title).toHaveLength(TITLE_MAX_LENGTH);
    expect(
      nextStreamCommand(
        input({
          stream: on(command!.title!),
          source: { ready: true, title: long },
        }),
      ),
    ).toBeNull();
  });
});

describe("streamTitle", () => {
  test("不切斷 emoji 等兩個 UTF-16 單位的字元", () => {
    const title = streamTitle("a".repeat(TITLE_MAX_LENGTH - 1) + "🎬🎬");
    expect(title).toBe("a".repeat(TITLE_MAX_LENGTH - 1));
  });

  test("空白片名送 null", () => {
    expect(streamTitle("  ")).toBeNull();
  });
});

describe("afterStreamCommandFailed（開播失敗後手動重試）", () => {
  const start = { session: 1, command: { live: true, title: "電影" } };

  test("開播被拒：取消意圖並忘掉紀錄，房主再按開始直播會重新送出", () => {
    const after = afterStreamCommandFailed(start, start);
    expect(after).toEqual({ lastSent: null, cancelIntent: true });
    // 意圖取消時不送任何請求（伺服器本來就是未開播）
    expect(
      nextStreamCommand(input({ intent: false, lastSent: after.lastSent })),
    ).toBeNull();
    // 房主再按一次「開始直播」
    expect(nextStreamCommand(input({ lastSent: after.lastSent }))).toEqual(
      start.command,
    );
  });

  test("停播被拒：忘掉紀錄但不動意圖，之後狀態變化時會再送停播", () => {
    const stop = { session: 1, command: { live: false, title: null } };
    const after = afterStreamCommandFailed(stop, stop);
    expect(after).toEqual({ lastSent: null, cancelIntent: false });
    expect(
      nextStreamCommand(
        input({ intent: false, stream: on("電影"), lastSent: after.lastSent }),
      ),
    ).toEqual({ live: false, title: null });
  });

  test("失敗的是較舊的請求：保留目前的紀錄與意圖", () => {
    const newer = { session: 2, command: { live: true, title: "電影" } };
    expect(afterStreamCommandFailed(newer, start)).toEqual({
      lastSent: newer,
      cancelIntent: false,
    });
  });
});
