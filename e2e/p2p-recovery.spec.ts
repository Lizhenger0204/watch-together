import { expect } from "@playwright/test";
import { submitJoin } from "./join-room";
import {
  beginWatching,
  expectPeers,
  expectPlaying,
  observePeers,
} from "./p2p-media";
import { expectWaiting, openLiveRoom, playMovie, startLive } from "./p2p-room";
import { test } from "./room-pages";

test.beforeEach(() => {
  test.setTimeout(90_000);
});

test("三方重新整理、轉發不可用與踢人後的 P2P 播放", async ({ newRoomPage }) => {
  const { host, viewers } = await openLiveRoom(newRoomPage);
  const [first, second] = viewers;

  await test.step("房主重新整理，重新選片後自動開播", async () => {
    await host.reload();
    await expect(
      host.getByRole("heading", { name: "直播暫停中" }),
    ).toBeVisible();
    await expectWaiting(...viewers);
    await playMovie(host, "h264-aac");
    await expect(
      host.getByRole("heading", { name: "直播中：h264-aac" }),
    ).toBeVisible();
    await expectPlaying(...viewers);
    await expectPeers(host, 2);
  });

  await test.step("一人重新整理並點擊觀看，原房間兩人都有畫面", async () => {
    await first.reload();
    await beginWatching(first);
    await expectPlaying(...viewers);
    await expectPeers(host, 2);
  });

  await test.step("轉發服務回 503 時顯示原因，切回 P2P 後兩人恢復", async () => {
    // 接上 relay 後真的會送 WHIP／WHEP；在本頁攔下並回 503，不打真實的 SFU。
    const posts = { whip: 0, whep: 0, viewerWhip: 0, hostWhep: 0 };
    for (const page of [host, ...viewers]) {
      const isHost = page === host;
      await page.route(/\/api\/rooms\/[^/]+\/(whip|whep)$/, (route) => {
        const request = route.request();
        const role = new URL(request.url()).pathname.endsWith("/whip")
          ? "whip"
          : "whep";
        if (request.method() === "POST") {
          if (role === "whip") posts[isHost ? "whip" : "viewerWhip"] += 1;
          else posts[isHost ? "hostWhep" : "whep"] += 1;
        }
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "RELAY_UNAVAILABLE",
              message: "轉發模式目前無法使用",
            },
          },
        });
      });
    }
    const relay = host.getByRole("button", { name: "轉發", exact: true });
    await relay.click();
    await expect(relay).toHaveAttribute("aria-pressed", "true");
    await expect(
      host.getByText("轉發模式目前無法使用，請房主改用「P2P 直連」。"),
    ).toBeVisible();
    await expect(
      host.getByRole("button", { name: "開始直播", exact: true }),
    ).toBeEnabled();
    await expectWaiting(...viewers);
    const p2p = host.getByRole("button", { name: "P2P 直連", exact: true });
    await p2p.click();
    await expect(p2p).toHaveAttribute("aria-pressed", "true");
    await startLive(host, "h264-aac");
    await expectPlaying(...viewers);
    // 房主的 WHIP 恰好 1 次（開播失敗後不重試）；收看者從沒拉過 WHEP。
    expect(posts).toEqual({ whip: 1, whep: 0, viewerWhip: 0, hostWhep: 0 });
    for (const page of [host, ...viewers]) await page.unrouteAll();
  });

  await test.step("踢出甲後釋放其連線，乙繼續在原連線觀看", async () => {
    const created = await second.evaluate(() => window.observedPeers.length);
    const member = host.getByRole("listitem").filter({ hasText: "朋友甲" });
    host.once("dialog", (dialog) => dialog.accept());
    await member.getByRole("button", { name: "踢出" }).click();
    await expect(first.getByText(/你已被房主請出房間/)).toBeVisible();
    await expect(first).toHaveURL("/");
    await expectPeers(first, 0);
    await expect(member).toHaveCount(0);
    await expectPeers(host, 1);
    await expectPlaying(second);
    await expectPeers(second, 1, created);
  });
});

test("房主選片前顯示片名，確認離開後撤銷身份，未收快照關閉分頁不影響原分頁恢復直播", async ({
  newRoomPage,
}) => {
  const [host, viewer] = await Promise.all([newRoomPage(), newRoomPage()]);
  await Promise.all([host, viewer].map(observePeers));
  await host.goto("/");
  await host.getByLabel("你的暱稱").first().fill("房主");
  await host.getByRole("button", { name: "建立房間", exact: true }).click();
  const code = host.getByTestId("invite-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const invite = await code.innerText();
  const roomUrl = host.url();

  // 未選片時顯示提示，選片後開播前即顯示本地片名。
  await expect(
    host.getByRole("heading", { name: "選擇要播放的影片", exact: true }),
  ).toBeVisible();
  await playMovie(host, "h264-aac");
  await expect(
    host.getByRole("heading", { name: "h264-aac", exact: true }),
  ).toBeVisible();

  await startLive(host, "h264-aac");
  await viewer.goto(`/join/${invite.replace("-", "")}`);
  await viewer.getByLabel("你的暱稱").fill("朋友");
  await submitJoin(viewer);
  await beginWatching(viewer);
  await expectPlaying(viewer);

  let holdSnapshot = false;
  await host.context().routeWebSocket(/\/ws$/, (ws) => {
    if (holdSnapshot) return;
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });

  // 雙分頁：由直播中的分頁 A 開啟同房分頁 B（繼承開播意圖），B 還在「連線中…」就關閉分頁，
  // 不可影響 A 重整後自動恢復直播。
  holdSnapshot = true;
  const [secondTab] = await Promise.all([
    host.context().waitForEvent("page"),
    host.evaluate(() => {
      window.open(location.href, "_blank");
    }),
  ]);
  await expect(secondTab.getByText("連線中…", { exact: true })).toBeVisible();
  await secondTab.close();
  await expect(
    host.getByRole("heading", { name: "直播中：h264-aac", exact: true }),
  ).toBeVisible();

  holdSnapshot = false;
  await host.reload();
  await expect(
    host.getByRole("heading", { name: "直播暫停中", exact: true }),
  ).toBeVisible();
  await playMovie(host, "h264-aac");
  await expect(
    host.getByRole("heading", { name: "直播中：h264-aac", exact: true }),
  ).toBeVisible();
  await expectPlaying(viewer);

  // 取消離房確認：維持直播。
  host.once("dialog", (dialog) => dialog.dismiss());
  await host.getByRole("button", { name: "離開房間", exact: true }).click();
  await expect(
    host.getByRole("heading", { name: "直播中：h264-aac", exact: true }),
  ).toBeVisible();

  // 確定離房：明確退房撤銷房主憑證並回首頁，收看者看到房主已離開，返回舊房顯示未加入。
  host.once("dialog", (dialog) => dialog.accept());
  await host.getByRole("button", { name: "離開房間", exact: true }).click();
  await expect(host).toHaveURL("/");
  await expect(
    viewer.getByText("房主已離開房間", { exact: true }),
  ).toBeVisible();
  await host.goto(roomUrl);
  await expect(host.getByText("你還沒加入這個房間")).toBeVisible();

  // 單分頁在重整連線中（未收 snapshot）明確離開房間，返回舊房也不會自動對外開播。
  const solo = await newRoomPage();
  await solo.goto("/");
  await solo.getByLabel("你的暱稱").first().fill("單分頁房主");
  await solo.getByRole("button", { name: "建立房間", exact: true }).click();
  await expect(solo.getByTestId("invite-code")).toHaveText(
    /^[A-Z2-9]{4}-[A-Z2-9]{4}$/,
  );
  const soloRoomUrl = solo.url();
  let holdSoloSnapshot = true;
  await solo.context().routeWebSocket(/\/ws$/, (ws) => {
    if (holdSoloSnapshot) return;
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });
  await solo.reload();
  await expect(solo.getByText("連線中…", { exact: true })).toBeVisible();
  await solo.getByRole("button", { name: "離開房間", exact: true }).click();
  await expect(solo).toHaveURL("/");
  holdSoloSnapshot = false;
  await solo.goto(soloRoomUrl);
  await expect(solo.getByText("你還沒加入這個房間")).toBeVisible();
});
