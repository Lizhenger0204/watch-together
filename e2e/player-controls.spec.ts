import { expect, type Page } from "@playwright/test";
import { test } from "./room-pages";

// 播放器控制列的使用者操作（T-125）：音量、畫質面板在窄視窗的位置、Escape 還焦點。
// 不播放影片，所以用 Playwright 內建 Chromium 即可（不在 chromeSpecs 內）。

async function createRoom(page: Page) {
  await page.goto("/");
  await page.getByLabel("你的暱稱").first().fill("房主");
  await page.getByRole("button", { name: "建立房間", exact: true }).click();
  await page.waitForURL(/\/rooms\//);
}

test("音量拉到 0 後取消靜音，回到最後的非零音量", async ({ newRoomPage }) => {
  const host = await newRoomPage();
  await createRoom(host);
  const slider = host.getByRole("slider", { name: "音量" });
  await slider.fill("0.35");
  await slider.fill("0");
  await host.getByRole("button", { name: "取消靜音" }).click();
  await expect(slider).toHaveValue("0.35");
  await expect(host.getByRole("button", { name: "靜音" })).toBeVisible();
});

for (const viewport of [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
]) {
  test(`畫質面板在 ${viewport.width}px 完整落在播放器內，Esc 關閉後焦點回到畫質按鈕`, async ({
    newRoomPage,
  }) => {
    const host = await newRoomPage();
    await host.setViewportSize(viewport);
    await createRoom(host);

    const player = host.locator("video").locator("..");
    const trigger = host.getByRole("button", { name: /^畫質：/ });
    await trigger.click();
    const panel = host.getByRole("dialog", { name: "畫質" });
    await expect(panel).toBeVisible();

    const playerBox = (await player.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.x).toBeGreaterThanOrEqual(playerBox.x);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(
      playerBox.x + playerBox.width + 0.5,
    );
    expect(panelBox.y).toBeGreaterThanOrEqual(playerBox.y);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(
      playerBox.y + playerBox.height + 0.5,
    );
    // 開啟後焦點先進面板。
    await expect(panel).toBeFocused();

    // 面板比播放器高時在面板內捲動；最下面的 FPS 滑桿捲進來後仍落在播放器內、可用鍵盤操作。
    const fps = panel.getByLabel("FPS");
    await fps.scrollIntoViewIfNeeded();
    const fpsBox = (await fps.boundingBox())!;
    expect(fpsBox.y).toBeGreaterThanOrEqual(playerBox.y);
    expect(fpsBox.y + fpsBox.height).toBeLessThanOrEqual(
      playerBox.y + playerBox.height + 0.5,
    );
    await fps.press("End");
    await expect(fps).toHaveAttribute("aria-valuetext", "原片");

    // 從面板內的滑桿按 Esc 關閉，焦點還給畫質按鈕。
    await host.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
