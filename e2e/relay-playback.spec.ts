import { expect } from "@playwright/test";
import { expectAudioPlaying, expectPeers, expectPlaying } from "./p2p-media";
import { openLiveRoom } from "./p2p-room";
import { createRelaySfu } from "./relay-sfu";
import { test } from "./room-pages";

test("轉發模式透過 SFU 替身播放影音，切回 P2P 後清理資源並繼續播放", async ({
  browser,
  newRoomPage,
}) => {
  const sfu = await createRelaySfu(browser);
  try {
    const { host, viewers } =
      await test.step("開播 h264-aac，兩位收看者在 P2P 正常觀看", () =>
        openLiveRoom(newRoomPage));

    await sfu.attach(host, "host");
    await Promise.all(viewers.map((viewer) => sfu.attach(viewer, "viewer")));

    await test.step("房主切到轉發模式：送出 1 次 WHIP、2 次 WHEP，兩人收到前進中的影音", async () => {
      const relay = host.getByRole("button", { name: "轉發", exact: true });
      await relay.click();
      await expect(relay).toHaveAttribute("aria-pressed", "true");
      await expect(
        host.getByRole("heading", { name: "直播中：h264-aac", exact: true }),
      ).toBeVisible();

      await expect.poll(() => sfu.stats().whip.length).toBe(1);
      await expect.poll(() => sfu.stats().whep.length).toBe(2);
      expect(sfu.stats()).toMatchObject({
        whipRequests: 1,
        whepRequests: 2,
        viewerWhip: 0,
        hostWhep: 0,
        missingAuth: 0,
        badContentType: 0,
      });
      await expect.poll(() => sfu.openPeers()).toBe(3);

      await expectPeers(host, 1);
      await Promise.all(viewers.map((viewer) => expectPeers(viewer, 1)));
      await expectPlaying(...viewers);
      await expectAudioPlaying(...viewers);
    });

    await test.step("房主切回 P2P 直連：3 個轉發資源全數 DELETE 並清理，兩人繼續以 P2P 播放影音", async () => {
      const created = [...sfu.stats().whip, ...sfu.stats().whep];
      expect(created).toHaveLength(3);

      const p2p = host.getByRole("button", { name: "P2P 直連", exact: true });
      await p2p.click();
      await expect(p2p).toHaveAttribute("aria-pressed", "true");
      await expect(
        host.getByRole("heading", { name: "直播中：h264-aac", exact: true }),
      ).toBeVisible();

      await expect
        .poll(() => [...sfu.stats().deleted].sort())
        .toEqual([...created].sort());
      await expect.poll(() => sfu.openPeers()).toBe(0);
      expect(sfu.stats()).toMatchObject({
        whipRequests: 1,
        whepRequests: 2,
      });
      expect(sfu.stats().whip).toHaveLength(1);
      expect(sfu.stats().whep).toHaveLength(2);

      await expectPeers(host, 2);
      await Promise.all(viewers.map((viewer) => expectPeers(viewer, 1)));
      await expectPlaying(...viewers);
      await expectAudioPlaying(...viewers);

      // 恢復 P2P 影音後再核對全部 DELETE 請求，確保無重複、遺漏或刪錯資源。
      expect([...sfu.stats().deleteRequests].sort()).toEqual(
        [...created].sort(),
      );
    });
  } finally {
    await sfu.close();
  }
});
