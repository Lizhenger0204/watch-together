import { expect } from "@playwright/test";
import { beginWatching, expectPeers, expectPlaying } from "./p2p-media";
import { expectWaiting, openLiveRoom, playMovie, startLive } from "./p2p-room";
import { test } from "./room-pages";

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
