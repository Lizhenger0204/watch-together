import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, type TestInfo } from "@playwright/test";

export function fixture(name: string) {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function checkBrowserErrors(page: Page) {
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (message.type() === "error") throw new Error(message.text());
  });
}

// 獨立 <video> 的結果不能由應用程式的 status 或 canPlayType() 推導。
export async function nativePlayback(
  page: Page,
  path: string,
  testInfo: TestInfo,
) {
  const bytes = await readFile(path);
  const result = await page.evaluate(async (base64) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(
      new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))]),
    );
    document.body.append(video);
    const snapshot = () => ({
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      mediaError: video.error
        ? { code: video.error.code, message: video.error.message }
        : null,
      userAgent: navigator.userAgent,
    });
    try {
      return await new Promise<ReturnType<typeof snapshot>>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          resolve(snapshot());
        };
        const timer = setTimeout(finish, 10_000);
        video.addEventListener("error", finish, { once: true });
        video.addEventListener("timeupdate", () => {
          if (video.currentTime >= 1) finish();
        });
        video.src = url;
        void video.play().catch(finish);
      });
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    }
  }, bytes.toString("base64"));
  const output = testInfo.outputPath("native-playback.json");
  await writeFile(output, JSON.stringify(result, null, 2));
  await testInfo.attach("native-playback", {
    path: output,
    contentType: "application/json",
  });
  return result;
}

export async function expectFramesAdvance(page: Page, testInfo: TestInfo) {
  const video = page.locator("video");
  const before = await video.evaluate((element: HTMLVideoElement) => ({
    time: element.currentTime,
    frames: element.getVideoPlaybackQuality().totalVideoFrames,
  }));
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(before.time + 0.25);
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) =>
          element.getVideoPlaybackQuality().totalVideoFrames,
      ),
    )
    .toBeGreaterThan(before.frames + 2);
  await expect(video).toHaveJSProperty("videoWidth", 160);
  const after = await video.evaluate((element: HTMLVideoElement) => ({
    time: element.currentTime,
    frames: element.getVideoPlaybackQuality().totalVideoFrames,
    width: element.videoWidth,
    height: element.videoHeight,
    paused: element.paused,
    mediaError: element.error?.code ?? null,
  }));
  const output = testInfo.outputPath("app-playback.json");
  await writeFile(
    output,
    JSON.stringify(
      {
        browserVersion: page.context().browser()?.version(),
        before,
        after,
        captured: await page
          .getByText(/擷取音軌 \d・擷取影像軌 \d/)
          .textContent(),
      },
      null,
      2,
    ),
  );
  await testInfo.attach("app-playback", {
    path: output,
    contentType: "application/json",
  });
}
