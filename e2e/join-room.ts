import {
  expect,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";

const JOIN_RETRY = {
  intervals: [2_000, 5_000, 10_000],
  timeout: 75_000,
};

/** 同一台電腦連跑多輪 E2E 會觸發每分鐘 10 次限流；僅對 HTTP 429 重試。 */
async function pollUntilNotRateLimited<
  T extends { status(): number; ok(): boolean },
>(attempt: () => Promise<T>, throwOnNonOk: boolean): Promise<T> {
  let latest!: T;
  await expect
    .poll(async () => {
      latest = await attempt();
      if (throwOnNonOk && !latest.ok() && latest.status() !== 429) {
        throw new Error(`加入房間失敗（HTTP ${latest.status()}）`);
      }
      return latest.status();
    }, JOIN_RETRY)
    .not.toBe(429);
  return latest;
}

/** 點擊表單「加入」並等待 `/api/rooms/join`，遇到 429 限流時自動重試。 */
export async function submitJoin(
  page: Page,
  button: Locator = page.getByRole("button", { name: "加入", exact: true }),
): Promise<void> {
  await pollUntilNotRateLimited(async () => {
    const [response] = await Promise.all([
      page.waitForResponse("**/api/rooms/join"),
      button.click(),
    ]);
    return response;
  }, true);
}

/** 直接呼叫 `POST /api/rooms/join`，遇到 429 限流時自動重試並回傳最終回應。 */
export async function postJoin(
  page: Page,
  data: Record<string, unknown>,
): Promise<APIResponse> {
  return pollUntilNotRateLimited(
    () => page.request.post("/api/rooms/join", { data }),
    false,
  );
}
