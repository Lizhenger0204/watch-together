import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { expectPlaying } from "./p2p-media";
import { test } from "./room-pages";

// 長片名（沒有空白的檔名）在手機寬度撐寬版面，T-105 第二輪和 T-117 審查都抓到過，
// 用這個測試攔住，不靠文件提醒。
const LONG_NAME =
  "Very.Long.Movie.Title.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.7.1-SOMEGROUP.Extended.Directors.Cut.Remastered.mp4";
const PHONE = { width: 390, height: 844 };

const pageWidth = (page: Page) =>
  page.locator("html").evaluate((html) => html.scrollWidth);

test.use({ viewport: PHONE });

test("長片名開播後，房主頁與收看頁在 390px 都不會被撐寬", async ({
  newRoomPage,
}) => {
  const host = await newRoomPage();
  await host.goto("/");
  await host.getByLabel("你的暱稱").first().fill("房主");
  await host.getByRole("button", { name: "建立房間", exact: true }).click();
  await host.waitForURL(/\/rooms\//);

  await host.getByLabel("選擇影片").setInputFiles({
    name: LONG_NAME,
    mimeType: "video/mp4",
    buffer: readFileSync(
      fileURLToPath(new URL("./fixtures/h264-aac.mp4", import.meta.url)),
    ),
  });
  await expect(host.getByText("檢查通過")).toBeVisible();
  await host.locator("video").evaluate((video: HTMLVideoElement) => {
    video.loop = true;
  });
  await host.getByRole("button", { name: "播放", exact: true }).click();
  await host.getByRole("button", { name: "開始直播" }).click();
  await expect(host.getByText(/直播中：/)).toBeVisible();
  expect(await pageWidth(host)).toBeLessThanOrEqual(PHONE.width);

  const inviteCode = await host.getByTestId("invite-code").innerText();

  const viewer = await newRoomPage();
  await viewer.goto(`/join/${inviteCode.replace("-", "")}`);
  await viewer.getByLabel("你的暱稱").last().fill("朋友");
  await viewer.getByRole("button", { name: "加入", exact: true }).click();
  await viewer.waitForURL(/\/rooms\//);
  await expect(viewer.getByText(LONG_NAME.replace(/\.mp4$/, ""))).toBeVisible();
  await viewer.getByRole("button", { name: /點擊開始觀看/ }).click();
  await expectPlaying(viewer);
  expect(await pageWidth(viewer)).toBeLessThanOrEqual(PHONE.width);
});
