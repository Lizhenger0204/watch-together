import { describe, expect, test, vi } from "vitest";
import {
  DELETE_RETRY_DELAYS_MS,
  DELETE_TIMEOUT_MS,
  deleteResource,
  postOffer,
} from "./http";
import {
  answerSdp,
  location,
  ROOM,
  TOKEN,
  useRelayFakes,
} from "./test-fixtures";

const http = useRelayFakes();
const PAGE = "https://watch.example:8443/room/abc";

async function post(role: "whip" | "whep", status: number, body = "") {
  const result = postOffer(ROOM, role, TOKEN, "v=0").catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(0);
  http().lastPost().respond(status, body);
  return (await result) as { code: string; message: string };
}

describe("Location 驗證", () => {
  test("同源的絕對 Location：以頁面 origin 解析，回傳本房間資源路徑", async () => {
    vi.stubGlobal("location", new URL(PAGE));
    const result = postOffer(ROOM, "whip", TOKEN, "v=0");
    await vi.advanceTimersByTimeAsync(0);
    http()
      .lastPost()
      .respond(201, answerSdp, {
        Location: `https://watch.example:8443${location()}`,
      });
    await expect(result).resolves.toEqual({
      answer: answerSdp,
      location: location(),
    });
  });

  test.each([
    ["其他 origin", `https://evil.example${location()}`],
    ["同主機不同 port", `https://watch.example:9999${location()}`],
    ["不同協定", `http://watch.example:8443${location()}`],
    ["他房路徑", "https://watch.example:8443/api/rooms/other/relay/abc"],
    [
      "資源 ID 不合法",
      `https://watch.example:8443/api/rooms/${ROOM}/relay/a.b`,
    ],
  ])("拒絕：%s", async (_name, bad) => {
    vi.stubGlobal("location", new URL(PAGE));
    const result = postOffer(ROOM, "whip", TOKEN, "v=0").catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    http().lastPost().respond(201, answerSdp, { Location: bad });
    expect(await result).toMatchObject({ code: "RELAY_FAILED" });
  });
});

describe("WHIP／WHEP 錯誤碼對應", () => {
  test("WHIP 409：提示房主先切換到轉發模式", async () => {
    const error = await post("whip", 409);
    expect(error.code).toBe("STREAM_NOT_LIVE");
    expect(error.message).toContain("請先切換到轉發模式");
  });

  test("WHEP 409：STREAM_NOT_LIVE（收看者等待開播）", async () => {
    const error = await post("whep", 409);
    expect(error.code).toBe("STREAM_NOT_LIVE");
    expect(error.message).not.toContain("切換到轉發模式");
  });

  test.each([
    ["whep", 401, "已不在房間"],
    ["whep", 403, "已不在房間"],
    ["whip", 401, "房主身份已失效"],
    ["whip", 403, "只有房主"],
  ] as const)(
    "%s %i：RELAY_FAILED 並附可讀原因",
    async (role, status, text) => {
      const error = await post(role, status);
      expect(error.code).toBe("RELAY_FAILED");
      expect(error.message).toContain(text);
      expect(error.message).not.toContain(TOKEN);
    },
  );
});

describe("DELETE 逾時", () => {
  test("單次 DELETE 沒回應：逾時後中止並依退避重試", async () => {
    const outcome = deleteResource(location(), TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(http().deletes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DELETE_TIMEOUT_MS - 1);
    expect(http().deletes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + DELETE_RETRY_DELAYS_MS[0]);
    expect(http().deletes()).toHaveLength(2);
    http().deletes()[1]!.respond(200);
    await expect(outcome).resolves.toBe("deleted");
  });

  test("每次 DELETE 都帶 AbortSignal", async () => {
    void deleteResource(location(), TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    const init = http().fetch.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
