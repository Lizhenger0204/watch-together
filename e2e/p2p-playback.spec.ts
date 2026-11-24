import { expect } from "@playwright/test";
import { expectPeers, expectPlaying } from "./p2p-media";
import { expectWaiting, openLiveRoom, playMovie, startLive } from "./p2p-room";
import { test } from "./room-pages";

test("兩人點擊後收到影音，重播、換片與停播重開後仍可觀看", async ({
  newRoomPage,
}) => {
  const { host, viewers } =
    await test.step("開播後兩人加入，點擊前暫停、點擊後有聲有影", () =>
      openLiveRoom(newRoomPage));

  await test.step("自然播完後重播，兩條原連線恢復出畫", async () => {
    const video = host.locator("video");
    await video.evaluate((element: HTMLVideoElement) => {
      element.loop = false;
    });
    await expect(video).toHaveJSProperty("ended", true, { timeout: 10_000 });
    await host.getByRole("button", { name: "播放", exact: true }).click();
    await expectPlaying(...viewers);
    await expectPeers(host, 2, 2);
  });

  await test.step("直播中換另一支影片，兩人收到新片名與畫面，沿用原連線", async () => {
    await playMovie(host, "h264-silent");
    await expect(
      host.getByRole("heading", { name: "直播中：h264-silent" }),
    ).toBeVisible();
    for (const viewer of viewers) {
      await expect(
        viewer.getByRole("heading", { name: "h264-silent", exact: true }),
      ).toBeVisible();
    }
    await expectPlaying(...viewers);
    await expectPeers(host, 2, 2);
  });

  await test.step("停播後清空連線，重開後兩人自動恢復", async () => {
    await host.getByRole("button", { name: "停止直播" }).click();
    await expectWaiting(...viewers);
    await expectPeers(host, 0);
    await startLive(host, "h264-silent");
    await expectPlaying(...viewers);
    await expectPeers(host, 2);
  });
});
