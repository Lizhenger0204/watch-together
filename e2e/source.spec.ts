import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function fixture(name: string) {
  return fileURLToPath(new URL(`./fixtures/${name}.mp4`, import.meta.url));
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (message.type() === "error") throw new Error(message.text());
  });
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await page.goto("/?demo=source");
});

test("plays a local movie and replaces its captured stream after selecting another file", async ({
  page,
}, testInfo) => {
  const input = page.getByLabel("選擇影片");
  const video = page.locator("video");
  const play = page.getByRole("button", { name: "播放", exact: true });

  await page.screenshot({ path: testInfo.outputPath("source-empty.png") });
  await input.setInputFiles(fixture("h264-aac"));
  await expect(page.getByRole("status")).toHaveText("檢查通過，可以播放。");
  await expect(video).toHaveJSProperty("paused", true);
  await expect(video).toHaveJSProperty("currentTime", 0);
  await expect(video).toHaveJSProperty("muted", false);
  await expect(page.getByText("擷取音軌 1・擷取影像軌 1")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("source-ready.png") });

  await play.click();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "暫停", exact: true }).click();
  await expect(video).toHaveJSProperty("paused", true);
  const seek = page.getByRole("slider", { name: "影片進度" });
  await seek.press("End");
  await expect(video).toHaveJSProperty("currentTime", 6);
  await seek.press("Home");
  await expect(video).toHaveJSProperty("currentTime", 0);
  await page.getByRole("slider", { name: "本地音量" }).press("Home");
  await expect(video).toHaveJSProperty("volume", 0);

  const fullscreen = page.getByRole("button", { name: "全螢幕" });
  const isFullscreen = () =>
    video.evaluate((element) =>
      Boolean(element.ownerDocument.fullscreenElement?.contains(element)),
    );
  await fullscreen.press("Enter");
  await expect.poll(isFullscreen).toBe(true);
  await fullscreen.press("Enter");
  await expect.poll(isFullscreen).toBe(false);

  await input.setInputFiles(fixture("h264-silent"));
  await expect(page.getByRole("status")).toContainText("影片沒有音軌");
  await expect(play).toBeDisabled();
  await expect(page.getByText("擷取音軌 0・擷取影像軌 0")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("source-no-audio-mobile.png"),
  });

  await page.getByRole("button", { name: "繼續播放無聲影片" }).click();
  await expect(page.getByRole("status")).toHaveText("可以播放（無聲）");
  await expect(page.getByText("擷取音軌 0・擷取影像軌 1")).toBeVisible();
  await play.click();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
});

test("checks HEVC playback or displays a decode error on unsupported hosts", async ({
  page,
}, testInfo) => {
  const input = page.getByLabel("選擇影片");
  await input.setInputFiles(fixture("hevc-aac"));
  const status = page.getByRole("status");
  await expect(status).toHaveText(/檢查通過|影像無法解碼/);

  if ((await status.textContent())?.includes("檢查通過")) {
    await expect(page.getByText("擷取音軌 1・擷取影像軌 1")).toBeVisible();
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate((element: HTMLVideoElement) => element.currentTime),
      )
      .toBeGreaterThan(0);
    console.log("HEVC: decoded and played with video and audio tracks");
  } else {
    await expect(
      page.getByRole("button", { name: "播放", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText("擷取音軌 0・擷取影像軌 0")).toBeVisible();
    console.log("HEVC: decode error shown and playback disabled");
  }
  await page.screenshot({ path: testInfo.outputPath("source-hevc.png") });
});
