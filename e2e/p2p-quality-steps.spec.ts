import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./room-pages";

// 畫質面板的使用者操作（T-126）：連續調整時房間廣播延遲、請求被拒、片源高度限制。
// 不開播也能調整畫質，所以只需要房主一個分頁；選片用的是會用到 H.264 的 chrome 專案。

type QualityRequest = {
  quality: { height: number; bitrate: number | string; fps: number | string };
};

/** 攔截房主的 WebSocket：記錄 room:update、可延遲 room:updated 廣播、可代替伺服器拒絕請求。 */
async function controlSocket(page: Page) {
  const control = {
    sent: [] as QualityRequest[],
    holding: false,
    rejecting: false,
    held: [] as (() => void)[],
    releaseBroadcasts() {
      control.holding = false;
      for (const send of control.held.splice(0)) send();
    },
  };
  await page.routeWebSocket(/\/api\/rooms\/[^/]+\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const data = JSON.parse(String(message)) as {
        type: string;
        reqId?: string;
        quality?: QualityRequest["quality"];
      };
      if (data.type === "room:update" && data.quality) {
        control.sent.push({ quality: data.quality });
        if (control.rejecting) {
          ws.send(
            JSON.stringify({
              type: "ack",
              reqId: data.reqId,
              ok: false,
              code: "FORBIDDEN",
            }),
          );
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const type = (JSON.parse(String(message)) as { type: string }).type;
      if (control.holding && type === "room:updated") {
        control.held.push(() => ws.send(message));
        return;
      }
      ws.send(message);
    });
  });
  return control;
}

async function createRoom(page: Page) {
  await page.goto("/");
  await page.getByLabel("你的暱稱").first().fill("房主");
  await page.getByRole("button", { name: "建立房間", exact: true }).click();
  await page.waitForURL(/\/rooms\//);
}

test("連續調整 8→10→15→8、房間廣播延遲：最後的 8 Mbps 一定生效，面板不跳回舊值", async ({
  newRoomPage,
}) => {
  const host = await newRoomPage();
  const control = await controlSocket(host);
  await createRoom(host);
  await host.getByRole("button", { name: /^畫質/ }).click();
  const panel = host.getByRole("dialog", { name: "畫質" });
  const bitrate = panel.getByLabel("位元率");
  await expect(bitrate).toHaveAttribute("aria-valuetext", "8 Mbps");

  control.holding = true;
  await bitrate.press("ArrowRight");
  await bitrate.press("ArrowRight");
  await bitrate.press("Home");
  await expect
    .poll(() => control.sent.map((r) => r.quality.bitrate))
    .toEqual([10_000_000, 15_000_000, 8_000_000]);
  await expect(bitrate).toHaveAttribute("aria-valuetext", "8 Mbps");

  control.releaseBroadcasts();
  await expect(bitrate).toHaveAttribute("aria-valuetext", "8 Mbps");
  // 重新整理後以伺服器的畫質為準，仍是最後的選擇。
  await host.reload();
  await host.getByRole("button", { name: /^畫質/ }).click();
  await expect(
    host.getByRole("dialog", { name: "畫質" }).getByLabel("位元率"),
  ).toHaveAttribute("aria-valuetext", "8 Mbps");
});

test("先鎖房再調 8→10 Mbps、廣播延遲時改 FPS：第二筆要帶著 10 Mbps，鎖房的廣播不能充當畫質確認", async ({
  newRoomPage,
}) => {
  const host = await newRoomPage();
  const control = await controlSocket(host);
  await createRoom(host);
  const locked = host.getByRole("checkbox", { name: /鎖定房間/ });

  // 鎖房：它的 room:updated 先正常抵達（畫質仍是 8 Mbps）。
  await locked.click();
  await expect(locked).toBeChecked();

  await host.getByRole("button", { name: /^畫質/ }).click();
  const panel = host.getByRole("dialog", { name: "畫質" });
  const bitrate = panel.getByLabel("位元率");
  const fps = panel.getByLabel("FPS");
  control.holding = true;
  await bitrate.press("ArrowRight");
  await expect.poll(() => control.sent.length).toBe(1);
  await fps.press("End");
  await expect.poll(() => control.sent.length).toBe(2);
  expect(control.sent.map((r) => [r.quality.bitrate, r.quality.fps])).toEqual([
    [10_000_000, 30],
    [10_000_000, "source"],
  ]);

  control.releaseBroadcasts();
  await expect(bitrate).toHaveAttribute("aria-valuetext", "10 Mbps");
  await expect(fps).toHaveAttribute("aria-valuetext", "原片");
});

test("房間拒絕畫質請求：面板自動回到房間真實的畫質並顯示錯誤，不必重開面板", async ({
  newRoomPage,
}) => {
  const host = await newRoomPage();
  const control = await controlSocket(host);
  await createRoom(host);
  await host.getByRole("button", { name: /^畫質/ }).click();
  const bitrate = host
    .getByRole("dialog", { name: "畫質" })
    .getByLabel("位元率");

  control.rejecting = true;
  await bitrate.press("End");
  await expect.poll(() => control.sent.length).toBe(1);
  await expect(bitrate).toHaveAttribute("aria-valuetext", "8 Mbps");
  await expect(host.getByText("只有房主可以這樣做。")).toBeVisible();
});

test("1000P 片源、設定 1080P：直接選 900P 能提交並更新按鈕；720P 以下也能選", async ({
  newRoomPage,
}) => {
  const host = await newRoomPage();
  // 夾具只有 90P：把 <video> 回報的高度改成 1000，模擬 1000P 片源。
  await host.addInitScript(() => {
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
      get: () => 1000,
    });
  });
  const control = await controlSocket(host);
  await createRoom(host);
  await host
    .getByLabel("選擇影片")
    .setInputFiles(
      fileURLToPath(new URL("./fixtures/h264-aac.mp4", import.meta.url)),
    );
  await expect(host.getByText("檢查通過，可以播放。")).toBeVisible();
  await host.getByRole("button", { name: /^畫質/ }).click();
  const panel = host.getByRole("dialog", { name: "畫質" });
  const height = panel.getByLabel("解析度");

  // 目前原高（片源 1000P）與可選檔位分開顯示：設定仍是 1080P，實際以 1000P 送出。
  await expect(height).toHaveAttribute("aria-valuetext", "1000P（片源）");
  await expect(host.getByRole("button", { name: "畫質：1000P" })).toBeVisible();

  await height.press("ArrowLeft");
  await expect
    .poll(() => control.sent.map((r) => r.quality.height))
    .toEqual([900]);
  await expect(height).toHaveAttribute("aria-valuetext", "900P");
  await expect(host.getByRole("button", { name: "畫質：900P" })).toBeVisible();

  // 高於片源的 1080P 不可選：往右拉不會送出。
  await height.press("ArrowRight");
  await height.press("Home");
  await expect
    .poll(() => control.sent.map((r) => r.quality.height))
    .toEqual([900, 720]);
  await expect(host.getByRole("button", { name: "畫質：720P" })).toBeVisible();
});
