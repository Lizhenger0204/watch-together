import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// 長片名（沒有空白的檔名）在手機寬度撐寬版面，T-105 第二輪和 T-117 審查都抓到過，
// 用這個測試攔住，不靠文件提醒。
const LONG_NAME =
  "Very.Long.Movie.Title.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.7.1-SOMEGROUP.Extended.Directors.Cut.Remastered.mp4";
const PHONE = { width: 390, height: 844 };

const pageWidth = (page: Page) =>
  page.locator("html").evaluate((html) => html.scrollWidth);

test("長片名開播後，房主頁與收看頁在 390px 都不會被撐寬", async ({
  browser,
}) => {
  const hostContext = await browser.newContext({ viewport: PHONE });
  const host = await hostContext.newPage();
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
  await host.getByRole("button", { name: "開始直播" }).click();
  await expect(host.getByText(/直播中：/)).toBeVisible();
  expect(await pageWidth(host)).toBeLessThanOrEqual(PHONE.width);

  const inviteLink = await host.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.endsWith(":invite")) return localStorage.getItem(key);
    }
    return null;
  });
  expect(inviteLink).toBeTruthy();

  const viewer = await (
    await browser.newContext({ viewport: PHONE })
  ).newPage();
  await viewer.goto(`/join/${inviteLink}`);
  await viewer.getByLabel("你的暱稱").last().fill("朋友");
  await viewer.getByRole("button", { name: "加入", exact: true }).click();
  await viewer.waitForURL(/\/rooms\//);
  await expect(viewer.getByText(LONG_NAME.replace(/\.mp4$/, ""))).toBeVisible();
  expect(await pageWidth(viewer)).toBeLessThanOrEqual(PHONE.width);
});
