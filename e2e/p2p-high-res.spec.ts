import { expect, type Page } from "@playwright/test";
import { submitJoin } from "./join-room";
import {
  beginWatching,
  expectPeers,
  expectPlaying,
  observePeers,
} from "./p2p-media";
import { playMovie, startLive } from "./p2p-room";
import { test } from "./room-pages";

/** 房主每條未關閉連線的 video sender 編碼策略與縮放參數。 */
function hostVideoParameters(host: Page) {
  return host.evaluate(() =>
    window.observedPeers
      .filter((pc) => pc.signalingState !== "closed")
      .map((pc) => {
        const sender = pc
          .getSenders()
          .find((candidate) => candidate.track?.kind === "video");
        const params = sender?.getParameters();
        const encoding = params?.encodings[0];
        return {
          degradationPreference: params?.degradationPreference ?? null,
          scaleResolutionDownBy: encoding?.scaleResolutionDownBy ?? null,
          maxBitrate: encoding?.maxBitrate ?? null,
        };
      }),
  );
}

/** 收看端已連線 PC 的 video inbound-rtp 實際收到高度（frameHeight）。 */
function inboundVideoHeight(viewer: Page) {
  return viewer.evaluate(async () => {
    let best: number | null = null;
    for (const pc of window.observedPeers) {
      if (pc.connectionState !== "connected") continue;
      const report = await pc.getStats();
      for (const stat of report.values()) {
        if (stat.type === "inbound-rtp" && stat.kind === "video") {
          const height = Number(stat.frameHeight);
          if (
            Number.isFinite(height) &&
            height > 0 &&
            (best === null || height > best)
          ) {
            best = height;
          }
        }
      }
    }
    return best;
  });
}

test("P2P 4K 影片：2160P 與原片以 maintain-resolution 送出 2160，改 1080P 後縮放 2 倍降到 ≤1080", async ({
  newRoomPage,
}, testInfo) => {
  const [host, viewer] = await Promise.all([newRoomPage(), newRoomPage()]);
  await Promise.all([observePeers(host), observePeers(viewer)]);

  await host.goto("/");
  await host.getByLabel("你的暱稱").first().fill("房主");
  await host.getByRole("button", { name: "建立房間", exact: true }).click();
  const code = host.getByTestId("invite-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const invite = await code.innerText();
  await playMovie(host, "h264-2160p-aac");

  // 開播前把畫質切到 2160P，確認高畫質靜態提示與 4K 位元率提示出現。
  await host.getByRole("button", { name: /^畫質/ }).click();
  const panel = host.getByRole("dialog", { name: "畫質" });
  const height = panel.getByLabel("解析度");
  const bitrate = panel.getByLabel("位元率");
  await height.press("ArrowRight"); // 1440P
  await height.press("ArrowRight"); // 2160P
  await expect(height).toHaveAttribute("aria-valuetext", "2160P");
  await expect(panel.getByText("4K 建議 25 Mbps 以上")).toBeVisible();
  await expect(panel.getByText(/高畫質需要房主電腦有硬體編碼/)).toBeVisible();
  // 調到 25 Mbps 後 4K 位元率提示消失
  await bitrate.press("ArrowRight"); // 10M
  await bitrate.press("ArrowRight"); // 15M
  await bitrate.press("ArrowRight"); // 25M
  await expect(bitrate).toHaveAttribute("aria-valuetext", "25 Mbps");
  await expect(panel.getByText("4K 建議 25 Mbps 以上")).toHaveCount(0);
  await host.keyboard.press("Escape");

  await startLive(host, "h264-2160p-aac");

  await viewer.goto("/");
  const join = viewer
    .locator("form")
    .filter({ has: viewer.getByLabel("邀請碼") });
  await join.getByLabel("邀請碼").fill(invite);
  await join.getByLabel("你的暱稱").fill("朋友甲");
  await submitJoin(
    viewer,
    join.getByRole("button", { name: "加入", exact: true }),
  );
  await beginWatching(viewer);
  await expectPlaying(viewer);
  await expectPeers(host, 1);

  // (a) 2160P：房主 maintain-resolution / scale=1，收看端收到 2160，按鈕顯示 2160P
  await expect(host.getByRole("button", { name: "畫質：2160P" })).toBeVisible();
  await expect
    .poll(() => hostVideoParameters(host))
    .toEqual([
      {
        degradationPreference: "maintain-resolution",
        scaleResolutionDownBy: 1,
        maxBitrate: 25_000_000,
      },
    ]);
  await expect
    .poll(() => inboundVideoHeight(viewer), {
      timeout: 20_000,
      message: "2160P 模式下收看端 inbound-rtp frameHeight 應為 2160",
    })
    .toBe(2160);
  const height2160 = await inboundVideoHeight(viewer);

  // (b) 改為「原片」：收看端維持 2160，按鈕顯示「原片（2160P）」
  await host.getByRole("button", { name: /^畫質/ }).click();
  await panel.getByLabel("解析度").press("End");
  await expect(
    host.getByRole("button", { name: "畫質：原片（2160P）" }),
  ).toBeVisible();
  await expect
    .poll(() => hostVideoParameters(host))
    .toEqual([
      {
        degradationPreference: "maintain-resolution",
        scaleResolutionDownBy: 1,
        maxBitrate: 25_000_000,
      },
    ]);
  await expect
    .poll(() => inboundVideoHeight(viewer), {
      timeout: 20_000,
      message: "原片模式下收看端 inbound-rtp frameHeight 應維持 2160",
    })
    .toBe(2160);
  const heightSource = await inboundVideoHeight(viewer);

  // (c) 改回 1080P：房主 scale=2 / maintain-framerate，收看端實際高度降回 >0 且 ≤1080
  await panel.getByLabel("解析度").press("ArrowLeft"); // 2160P
  await panel.getByLabel("解析度").press("ArrowLeft"); // 1440P
  await panel.getByLabel("解析度").press("ArrowLeft"); // 1080P
  await expect(host.getByRole("button", { name: "畫質：1080P" })).toBeVisible();
  await expect
    .poll(() => hostVideoParameters(host))
    .toEqual([
      {
        degradationPreference: "maintain-framerate",
        scaleResolutionDownBy: 2,
        maxBitrate: 25_000_000,
      },
    ]);
  let height1080: number | null = null;
  await expect
    .poll(
      async () => {
        height1080 = await inboundVideoHeight(viewer);
        return height1080 !== null && height1080 > 0 && height1080 <= 1080;
      },
      {
        timeout: 20_000,
        message: "4K 切 1080P 後收看端 inbound-rtp frameHeight 應降到 1..1080",
      },
    )
    .toBe(true);
  expect(height1080).toBeGreaterThan(0);
  expect(height1080).toBeLessThanOrEqual(1080);

  const summary = `measured frameHeight: 2160P=${height2160}, source=${heightSource}, 1080P=${height1080}`;
  testInfo.annotations.push({
    type: "measured-frameHeight",
    description: summary,
  });
  console.log(summary);
});
