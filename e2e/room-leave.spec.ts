import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { postJoin, submitJoin } from "./join-room";

test.beforeEach(() => {
  test.setTimeout(90_000);
});

function watchErrors(page: Page, allowed?: RegExp) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // 僅略過限流重試的 429，或由該案例明確宣告的注入失敗。
    if (/Failed to load resource:.*429/.test(text)) return;
    if (allowed?.test(text)) return;
    errors.push(text);
  });
  return errors;
}

const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });

async function create(page: Page) {
  await page.goto("/");
  await page.getByLabel("你的暱稱").first().fill("退房房主");
  await page.getByRole("button", { name: "建立房間", exact: true }).click();
  await page.waitForURL(/\/rooms\//);
  const inviteCode = (
    await page.getByTestId("invite-code").innerText()
  ).replace("-", "");
  const roomId = new URL(page.url()).pathname.split("/").at(-1)!;
  const token = await page.evaluate(
    (id) => localStorage.getItem(`room:${id}:token`)!,
    roomId,
  );
  return { roomId, inviteCode, token };
}

async function saved(page: Page, roomId: string) {
  return page.evaluate(
    (id) => ({
      token: localStorage.getItem(`room:${id}:token`),
      invite: localStorage.getItem(`room:${id}:invite`),
    }),
    roomId,
  );
}

test("房主按離開立即釋出空房，舊身份與邀請碼皆不可再用", async ({
  page,
}, info) => {
  const errors = watchErrors(page);
  const room = await create(page);
  await shot(page, info, "01-host-room");
  await page.getByRole("button", { name: "離開房間", exact: true }).click();
  await expect(page).toHaveURL("/");
  await shot(page, info, "02-host-left");
  expect((await saved(page, room.roomId)).token === null).toBe(true);
  expect((await saved(page, room.roomId)).invite === null).toBe(true);
  const denied = await page.request.get(`/api/rooms/${room.roomId}/ice`, {
    headers: { Authorization: `Bearer ${room.token}` },
  });
  expect(denied.status()).toBe(401);
  const rejoin = await postJoin(page, {
    inviteCode: room.inviteCode,
    nickname: "新人",
  });
  expect(rejoin.status()).toBe(404);
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByText("你還沒加入這個房間")).toBeVisible();
  await shot(page, info, "03-old-room-denied");
  expect(errors).toEqual([]);
});

test("收看者按離開移除席位，房主仍在線且可用邀請碼重新加入", async ({
  browser,
  page,
}, info) => {
  const errors = watchErrors(page);
  const room = await create(page);
  const viewerContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const viewer = await viewerContext.newPage();
  const viewerErrors = watchErrors(viewer);
  try {
    await viewer.goto(`/join/${room.inviteCode}`);
    await viewer.getByLabel("你的暱稱").fill("退房朋友");
    await submitJoin(viewer);
    await expect(viewer).toHaveURL(`/rooms/${room.roomId}`);
    await expect(page.getByText("退房朋友")).toBeVisible();
    const token = (await saved(viewer, room.roomId)).token!;
    await shot(viewer, info, "01-viewer-room");
    await viewer.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(viewer).toHaveURL("/");
    await expect(page.getByText("退房朋友")).toHaveCount(0);
    await shot(page, info, "02-host-member-removed");
    expect((await saved(viewer, room.roomId)).token === null).toBe(true);
    expect((await saved(viewer, room.roomId)).invite === null).toBe(true);
    expect(
      (
        await page.request.get(`/api/rooms/${room.roomId}/ice`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status(),
    ).toBe(401);
    await viewer.goto(`/join/${room.inviteCode}`);
    await submitJoin(viewer);
    await expect(viewer).toHaveURL(`/rooms/${room.roomId}`);
    await expect(page.getByText("退房朋友")).toBeVisible();
    expect((await saved(viewer, room.roomId)).token !== token).toBe(true);
    expect(viewerErrors).toEqual([]);
    await shot(viewer, info, "03-viewer-rejoined");
    expect(errors).toEqual([]);
  } finally {
    await viewerContext.close();
  }
});

for (const failure of ["server", "network"] as const) {
  test(`${failure} 退房失敗保留頁面與身份，重試成功才離開`, async ({
    page,
  }, info) => {
    const errors = watchErrors(
      page,
      failure === "network"
        ? /Failed to load resource:.*ERR_FAILED/
        : /Failed to load resource:.*503/,
    );
    const room = await create(page);
    const before = await saved(page, room.roomId);
    await shot(page, info, "01-before-leave");
    await page.route("**/api/rooms/*/leave", (route) =>
      failure === "network"
        ? route.abort("failed")
        : route.fulfill({
            status: 503,
            json: { error: { code: "INTERNAL", message: "重試" } },
          }),
    );
    await page.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(
      page.getByText("伺服器出了點問題，請稍後再試。"),
    ).toBeVisible();
    await expect(page).toHaveURL(`/rooms/${room.roomId}`);
    expect(
      JSON.stringify(await saved(page, room.roomId)) === JSON.stringify(before),
    ).toBe(true);
    await shot(page, info, "02-error-stayed");
    await page.unroute("**/api/rooms/*/leave");
    await page.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(page).toHaveURL("/");
    expect((await saved(page, room.roomId)).token === null).toBe(true);
    expect((await saved(page, room.roomId)).invite === null).toBe(true);
    await shot(page, info, "03-retry-left");
    expect(errors).toEqual([]);
  });
}

test("退房回應遺失時留在錯誤畫面，重試已撤銷身份才回首頁", async ({
  page,
}, info) => {
  const errors = watchErrors(
    page,
    /Failed to load resource:.*(?:401|ERR_FAILED)/,
  );
  const room = await create(page);
  const before = await saved(page, room.roomId);
  await page.route("**/api/rooms/*/leave", async (route) => {
    expect((await route.fetch()).status()).toBe(204);
    await route.abort("failed");
  });
  await shot(page, info, "01-before-response-loss");
  await page.getByRole("button", { name: "離開房間", exact: true }).click();
  await expect(page.getByText("伺服器出了點問題，請稍後再試。")).toBeVisible();
  await expect(page).toHaveURL(`/rooms/${room.roomId}`);
  expect(
    JSON.stringify(await saved(page, room.roomId)) === JSON.stringify(before),
  ).toBe(true);
  await shot(page, info, "02-response-lost-stayed");
  await page.unroute("**/api/rooms/*/leave");
  await page.getByRole("button", { name: "離開房間", exact: true }).click();
  await expect(page).toHaveURL("/");
  expect((await saved(page, room.roomId)).token === null).toBe(true);
  await shot(page, info, "03-retry-confirmed-left");
  expect(errors).toEqual([]);
});

test("退房中另一分頁保存新身份，晚到回應保留新憑證與邀請對照", async ({
  page,
}, info) => {
  const errors = watchErrors(page);
  await page.goto("/");
  const created = await page.request.post("/api/rooms", {
    data: { nickname: "房主" },
  });
  const room = (await created.json()) as { roomId: string; inviteCode: string };
  await page.goto(`/join/${room.inviteCode}`);
  await page.getByLabel("你的暱稱").fill("舊身份");
  await submitJoin(page);
  await expect(page).toHaveURL(`/rooms/${room.roomId}`);
  const old = (await saved(page, room.roomId)).token!;
  const joined = await postJoin(page, {
    inviteCode: room.inviteCode,
    nickname: "新身份",
  });
  const next = (await joined.json()) as { memberToken: string };
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    resume = resolve;
  });
  await page.route("**/api/rooms/*/leave", async (route) => {
    entered();
    await ready;
    await route.continue();
  });
  await shot(page, info, "01-old-identity");
  await page.getByRole("button", { name: "離開房間", exact: true }).click();
  await seen;
  // 在同源第二分頁寫入新憑證與邀請對照，驗證跨分頁同源鎖與條件清除不覆蓋新身份
  const tab2 = await page.context().newPage();
  const tab2Errors = watchErrors(tab2);
  try {
    await tab2.goto("/");
    await tab2.evaluate(
      ({ roomId, token, inviteCode }) => {
        localStorage.setItem(`room:${roomId}:token`, token);
        localStorage.setItem(`room:${roomId}:invite`, inviteCode);
      },
      {
        roomId: room.roomId,
        token: next.memberToken,
        inviteCode: room.inviteCode,
      },
    );
    resume();
    await expect(page).toHaveURL("/");
    const stored = await saved(tab2, room.roomId);
    expect(stored.token === next.memberToken).toBe(true);
    expect(stored.invite === room.inviteCode).toBe(true);
    for (const [token, status] of [
      [old, 401],
      [next.memberToken, 200],
    ] as const) {
      expect(
        (
          await page.request.get(`/api/rooms/${room.roomId}/ice`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status(),
      ).toBe(status);
    }
    await shot(page, info, "02-new-identity-preserved");
    expect(tab2Errors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await tab2.close();
  }
});

test("保留房間時退房回應遺失收到 4401 仍留在錯誤畫面，重試才離房；點品牌連結連點只送一次退房", async ({
  browser,
  page,
}, info) => {
  const errors = watchErrors(
    page,
    /Failed to load resource:.*(?:401|ERR_FAILED)/,
  );
  const room = await create(page);
  const viewerContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const viewer = await viewerContext.newPage();
  const viewerErrors = watchErrors(viewer);
  try {
    await viewer.goto(`/join/${room.inviteCode}`);
    await viewer.getByLabel("你的暱稱").fill("留下觀眾");
    await submitJoin(viewer);
    await expect(viewer).toHaveURL(`/rooms/${room.roomId}`);
    await expect(page.getByText("留下觀眾")).toBeVisible();

    const before = await saved(page, room.roomId);
    await page.route("**/api/rooms/*/leave", async (route) => {
      expect((await route.fetch()).status()).toBe(204);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(
      page.getByText("伺服器出了點問題，請稍後再試。"),
    ).toBeVisible();
    await expect(page).toHaveURL(`/rooms/${room.roomId}`);
    expect(
      JSON.stringify(await saved(page, room.roomId)) === JSON.stringify(before),
    ).toBe(true);
    // 觀眾端已看到房主離開，房間仍保留
    await expect(
      viewer.getByText("房主已離開房間", { exact: true }),
    ).toBeVisible();
    await page.unroute("**/api/rooms/*/leave");
    await page.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(page).toHaveURL("/");
    expect((await saved(page, room.roomId)).token === null).toBe(true);

    // 觀眾點擊品牌連結並快速連點：只應送出一次 POST /leave
    let leavePosts = 0;
    let releaseLeave!: () => void;
    const holdLeave = new Promise<void>((resolve) => {
      releaseLeave = resolve;
    });
    await viewer.route("**/api/rooms/*/leave", async (route) => {
      leavePosts += 1;
      await holdLeave;
      await route.continue();
    });
    const brand = viewer.getByRole("link", { name: "遠端同步播放器" });
    await brand.click();
    await brand.click({ force: true });
    releaseLeave();
    await expect(viewer).toHaveURL("/");
    expect(leavePosts).toBe(1);
    await shot(viewer, info, "01-brand-single-leave");
    expect(viewerErrors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await viewerContext.close();
  }
});

test("有收看者在線時房主按離開僅移除房主並保留聊天室，收看者也離開後立即釋出空房", async ({
  browser,
  page,
}, info) => {
  const errors = watchErrors(page);
  const room = await create(page);
  const viewerContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const viewer = await viewerContext.newPage();
  const viewerErrors = watchErrors(viewer);
  try {
    await viewer.goto(`/join/${room.inviteCode}`);
    await viewer.getByLabel("你的暱稱").fill("留下聊天");
    await submitJoin(viewer);
    await expect(viewer).toHaveURL(`/rooms/${room.roomId}`);
    await expect(page.getByText("留下聊天")).toBeVisible();

    await page.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(page).toHaveURL("/");
    expect((await saved(page, room.roomId)).token === null).toBe(true);
    expect(
      (
        await page.request.get(`/api/rooms/${room.roomId}/ice`, {
          headers: { Authorization: `Bearer ${room.token}` },
        })
      ).status(),
    ).toBe(401);

    await expect(
      viewer.getByText("房主已離開房間", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.getByText("房主已離開房間。", { exact: true }),
    ).toBeVisible();
    await viewer.getByLabel("輸入聊天訊息").fill("房主離開我們繼續聊");
    await viewer.getByRole("button", { name: "送出訊息" }).click();
    await expect(
      viewer
        .getByRole("region", { name: "聊天室" })
        .getByText("房主離開我們繼續聊"),
    ).toBeVisible();
    await shot(viewer, info, "01-viewer-remains-after-host-left");

    await viewer.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(viewer).toHaveURL("/");
    expect((await saved(viewer, room.roomId)).token === null).toBe(true);
    const rejoin = await postJoin(page, {
      inviteCode: room.inviteCode,
      nickname: "新人",
    });
    expect(rejoin.status()).toBe(404);
    await shot(viewer, info, "02-room-released-after-last-left");
    expect(viewerErrors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await viewerContext.close();
  }
});
