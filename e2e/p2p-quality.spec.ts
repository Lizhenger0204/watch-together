import { expect, type Page } from "@playwright/test";
import { openLiveRoom } from "./p2p-room";
import { test } from "./room-pages";

/** 房主每條未關閉連線的 video sender 編碼參數。 */
function videoEncodings(host: Page) {
  return host.evaluate(() =>
    window.observedPeers
      .filter((pc) => pc.signalingState !== "closed")
      .map((pc) => {
        const sender = pc
          .getSenders()
          .find((candidate) => candidate.track?.kind === "video");
        const encoding = sender?.getParameters().encodings[0];
        return {
          maxBitrate: encoding?.maxBitrate,
          maxFramerate: encoding?.maxFramerate ?? null,
        };
      }),
  );
}

test("直播中用畫質面板的滑桿調整，現有連線即時套用新的位元率與 FPS", async ({
  newRoomPage,
}) => {
  const { host } = await openLiveRoom(newRoomPage);
  await expect
    .poll(() => videoEncodings(host))
    .toEqual([
      { maxBitrate: 8_000_000, maxFramerate: 30 },
      { maxBitrate: 8_000_000, maxFramerate: 30 },
    ]);

  await host.getByRole("button", { name: /^畫質/ }).click();
  const panel = host.getByRole("dialog", { name: "畫質" });

  // 滑鼠拖到 15 Mbps 再放開（放開的位置在滑桿外也要送出）。
  const bitrate = panel.getByLabel("位元率");
  const box = (await bitrate.boundingBox())!;
  await host.mouse.move(box.x + 2, box.y + box.height / 2);
  await host.mouse.down();
  await host.mouse.move(box.x + (box.width * 2) / 3, box.y + 40, {
    steps: 6,
  });
  await host.mouse.up();
  // 鍵盤把 FPS 調到「原片」（不限制幀率）。
  await panel.getByLabel("FPS").press("End");

  await expect
    .poll(() => videoEncodings(host))
    .toEqual([
      { maxBitrate: 15_000_000, maxFramerate: null },
      { maxBitrate: 15_000_000, maxFramerate: null },
    ]);
  await expect(panel.getByLabel("位元率")).toHaveAttribute(
    "aria-valuetext",
    "15 Mbps",
  );
  // 片源只有 90P：解析度滑桿停用，按鈕顯示實際送出的高度。
  await expect(panel.getByLabel("解析度")).toBeDisabled();
  await expect(host.getByRole("button", { name: "畫質：90P" })).toBeVisible();
});
