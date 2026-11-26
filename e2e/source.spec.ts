import { chromium, expect, test } from "@playwright/test";
import {
  checkBrowserErrors,
  expectFramesAdvance,
  fixture,
  nativePlayback,
} from "./source-media";

test.beforeEach(async ({ page }) => {
  checkBrowserErrors(page);
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await page.goto("/?demo=source");
});

test("plays a local movie and replaces its captured stream after selecting another file", async ({
  page,
}, testInfo) => {
  const input = page.getByLabel("選擇影片");
  const video = page.locator("video");
  const play = page.getByRole("button", { name: "播放", exact: true });
  const stageToggle = page.getByTestId("player-stage-toggle");

  await expect(stageToggle).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("source-empty.png") });
  await input.setInputFiles(fixture("h264-aac.mp4"));
  await expect(page.getByRole("status")).toHaveText("檢查通過，可以播放。");
  await expect(page.getByTestId("source-conversion")).toHaveAttribute(
    "data-converted",
    "false",
  );
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
  await stageToggle.click();
  await expect(video).toHaveJSProperty("paused", false);
  await expect(
    page.getByRole("button", { name: "暫停", exact: true }),
  ).toBeVisible();
  await stageToggle.click();
  await expect(video).toHaveJSProperty("paused", true);
  await expect(play).toBeVisible();
  const seek = page.getByRole("slider", { name: "影片進度" });
  await seek.press("End");
  await expect(video).toHaveJSProperty("currentTime", 6);
  await seek.press("Home");
  await expect(video).toHaveJSProperty("currentTime", 0);
  await page.getByRole("slider", { name: "音量" }).press("Home");
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

  await input.setInputFiles(fixture("h264-silent.mp4"));
  await expect(page.getByRole("status")).toContainText("影片沒有音軌");
  await expect(page.getByTestId("source-conversion")).toHaveAttribute(
    "data-converted",
    "false",
  );
  await expect(play).toBeDisabled();
  await expect(stageToggle).toHaveCount(0);
  await expect(page.getByText("擷取音軌 0・擷取影像軌 0")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("source-no-audio-mobile.png"),
  });

  await page.getByRole("button", { name: "繼續播放無聲影片" }).click();
  await expect(page.getByRole("status")).toHaveText("可以播放（無聲）");
  await expect(page.getByTestId("source-conversion")).toHaveAttribute(
    "data-converted",
    "false",
  );
  await expect(page.getByText("擷取音軌 0・擷取影像軌 1")).toBeVisible();
  await play.click();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
});

for (const name of [
  "hevc-aac.mp4",
  "hevc-main10-aac.mp4",
  "hevc-hev1-aac.mp4",
  "hevc-aac.mkv",
]) {
  test(`decodes, captures and plays ${name} on a HEVC-capable host`, async ({
    page,
  }, testInfo) => {
    const path = fixture(name);
    const native = await nativePlayback(page, path, testInfo);
    const decodable =
      native.mediaError === null &&
      native.width > 0 &&
      native.frames > 2 &&
      native.currentTime >= 1;
    test.skip(
      !decodable && process.env.HEVC_REQUIRED !== "1",
      `原生 Chrome 無法完成 ${name} 解碼；成功案例未驗證（width=${native.width}, frames=${native.frames}, time=${native.currentTime}, MediaError=${native.mediaError?.code ?? "無"}）。以 HEVC_REQUIRED=1 可強制此能力前提。`,
    );
    expect(
      native.mediaError,
      "此成功案例需要有 HEVC 原生解碼能力的 Chrome runner",
    ).toBeNull();
    expect(
      native.width,
      "原生 HEVC 解碼不可被應用程式的錯誤分支取代",
    ).toBeGreaterThan(0);
    expect(native.frames).toBeGreaterThan(2);
    expect(native.currentTime).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("source-empty.png") });
    await page.getByLabel("選擇影片").setInputFiles(path);
    await expect(page.getByRole("status")).toHaveText("檢查通過，可以播放。");
    const conversion = page.getByTestId("source-conversion");
    if (name === "hevc-main10-aac.mp4") {
      await expect(conversion).toHaveAttribute("data-converted", "true");
      await expect(conversion).toContainText("10-bit 片源，送出前轉為 8-bit");
    } else {
      await expect(conversion).toHaveAttribute("data-converted", "false");
    }
    await expect(page.getByText("擷取音軌 1・擷取影像軌 1")).toBeVisible();
    const video = page.locator("video");
    await expect(video).toHaveJSProperty("paused", true);
    await expect(video).toHaveJSProperty("currentTime", 0);
    await expect(video).toHaveJSProperty("seeking", false);
    await expect(video).toHaveJSProperty("muted", false);
    await page.screenshot({
      path: testInfo.outputPath("source-hevc-ready.png"),
    });
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expectFramesAdvance(page, testInfo);
    await page.screenshot({
      path: testInfo.outputPath("source-hevc-playing.png"),
    });
  });
}

test("reports a stalled native trial instead of accepting play() alone", async ({
  page,
}, testInfo) => {
  await page.locator("video").evaluate((video: HTMLVideoElement) => {
    video.defaultPlaybackRate = 0;
    video.playbackRate = 0;
  });
  await page.getByLabel("選擇影片").setInputFiles(fixture("h264-aac.mp4"));
  await expect(page.getByRole("status")).toHaveText("正在檢查影片…");
  await page.screenshot({
    path: testInfo.outputPath("source-stalled-checking.png"),
  });
  await expect(page.getByRole("status")).toHaveText(
    "影片載入或試播逾時，請重新選檔。",
    { timeout: 15_000 },
  );
  await expect(
    page.getByRole("button", { name: "播放", exact: true }),
  ).toBeDisabled();
  await page.getByText("播放診斷", { exact: true }).click();
  await expect(page.getByText("失敗階段：靜音試播")).toBeVisible();
  await expect(page.getByText(/^畫面格式：.+；8-bit 轉換：否$/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("source-stalled-diagnostic.png"),
    fullPage: true,
  });
});

test("diagnoses a host with native HEVC decoding disabled separately from playback success", async ({
  baseURL,
}, testInfo) => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--disable-features=PlatformHEVCDecoderSupport"],
  });
  try {
    const page = await browser.newPage({ baseURL });
    checkBrowserErrors(page);
    await page.route("**/favicon.ico", (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.goto("/?demo=source");
    const native = await nativePlayback(
      page,
      fixture("hevc-aac.mp4"),
      testInfo,
    );
    expect(native.width, "此案例必須真的關閉原生 HEVC 解碼").toBe(0);
    await page.getByLabel("選擇影片").setInputFiles(fixture("hevc-aac.mp4"));
    await expect(page.getByRole("status")).toContainText("影像無法解碼");
    await expect(
      page.getByRole("button", { name: "播放", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText("擷取音軌 0・擷取影像軌 0")).toBeVisible();
    await page.getByText("播放診斷", { exact: true }).click();
    await expect(page.getByText("失敗階段：載入中繼資料")).toBeVisible();
    await expect(page.getByText("影像：0 × 0", { exact: false })).toBeVisible();
    await expect(
      page.getByText("畫面格式：尚未讀取；8-bit 轉換：否"),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("source-hevc-unsupported.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
});

test("clicking the stage closes an open popover without toggling playback", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("你的暱稱").first().fill("房主");
  await page.getByRole("button", { name: "建立房間", exact: true }).click();
  await page.waitForURL(/\/rooms\//);

  await page.getByLabel("選擇影片").setInputFiles(fixture("h264-aac.mp4"));
  await expect(page.getByText("檢查通過，可以播放。")).toBeVisible();

  const video = page.locator("video");
  await video.evaluate((element: HTMLVideoElement) => {
    element.loop = true;
  });

  const stageToggle = page.getByTestId("player-stage-toggle");
  await stageToggle.click();
  await expect(video).toHaveJSProperty("paused", false);

  await page.getByRole("button", { name: /^畫質：/ }).click();
  const panel = page.getByRole("dialog", { name: "畫質" });
  await expect(panel).toBeVisible();

  await stageToggle.click({ position: { x: 24, y: 24 } });
  await expect(panel).toBeHidden();
  await expect(video).toHaveJSProperty("paused", false);

  await stageToggle.click();
  await expect(video).toHaveJSProperty("paused", true);
});
