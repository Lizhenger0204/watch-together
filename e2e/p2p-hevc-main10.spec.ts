import { expect } from "@playwright/test";
import { submitJoin } from "./join-room";
import {
  beginWatching,
  expectAudioPlaying,
  expectPeers,
  expectPlaying,
  observePeers,
} from "./p2p-media";
import { startLive } from "./p2p-room";
import { test } from "./room-pages";
import { fixture, nativePlayback } from "./source-media";

declare global {
  interface Window {
    bug004VideoTrack?: MediaStreamTrack | null;
  }
}

test("HEVC Main 10 經 8-bit 轉換後 P2P 開播不崩潰，播完重播維持同一 video track 並持續出畫", async ({
  newRoomPage,
}, testInfo) => {
  const [host, viewer] = await Promise.all([newRoomPage(), newRoomPage()]);
  let hostCrashed = false;
  host.on("crash", () => {
    hostCrashed = true;
  });
  await Promise.all([host, viewer].map(observePeers));
  await host.goto("/");

  const main10Path = fixture("hevc-main10-aac.mp4");
  const native = await nativePlayback(host, main10Path, testInfo);
  const decodable =
    native.mediaError === null &&
    native.width > 0 &&
    native.frames > 2 &&
    native.currentTime >= 1;
  test.skip(
    !decodable && process.env.HEVC_REQUIRED !== "1",
    `原生 Chrome 無法完成 hevc-main10-aac.mp4 解碼；Main 10 P2P 案例未驗證（width=${native.width}, frames=${native.frames}, time=${native.currentTime}, MediaError=${native.mediaError?.code ?? "無"}）。以 HEVC_REQUIRED=1 可強制此能力前提。`,
  );
  expect(
    native.mediaError,
    "此案例需要有 HEVC Main 10 原生解碼能力的 Chrome runner",
  ).toBeNull();
  expect(native.width).toBeGreaterThan(0);
  expect(native.frames).toBeGreaterThan(2);
  expect(native.currentTime).toBeGreaterThanOrEqual(1);

  await test.step("房主選 Main 10 片源開播，收看端正常出畫且房主分頁未崩潰", async () => {
    await host.getByLabel("你的暱稱").first().fill("房主");
    await host.getByRole("button", { name: "建立房間", exact: true }).click();
    const code = host.getByTestId("invite-code");
    await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const invite = await code.innerText();

    await host.getByLabel("選擇影片").setInputFiles(main10Path);
    await expect(host.getByRole("status")).toHaveText("檢查通過，可以播放。");

    await host.locator("video").evaluate((video: HTMLVideoElement) => {
      video.loop = true;
    });
    await host.getByRole("button", { name: "播放", exact: true }).click();
    await startLive(host, "hevc-main10-aac");

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

    expect(hostCrashed, "房主分頁不可在送出 Main 10 畫面時崩潰").toBe(false);
    await expectPlaying(viewer);
    await expectPeers(host, 1, 1);

    const conversion = host.getByTestId("source-conversion");
    await expect(conversion).toHaveAttribute("data-converted", "true");
    await expect(conversion).toContainText("10-bit 片源，送出前轉為 8-bit");
  });

  await test.step("自然播完後重播，送出的 video track 物件不變且收看端影格與音訊持續前進", async () => {
    const savedTrack = await host.evaluate(() => {
      const pc = window.observedPeers.find(
        (peer) => peer.signalingState !== "closed",
      );
      const videoSender = pc
        ?.getSenders()
        .find((sender) => sender.track?.kind === "video");
      window.bug004VideoTrack = videoSender?.track ?? null;
      return videoSender?.track
        ? {
            id: videoSender.track.id,
            readyState: videoSender.track.readyState,
            height: videoSender.track.getSettings().height ?? null,
          }
        : null;
    });
    expect(savedTrack).not.toBeNull();
    expect(savedTrack?.readyState).toBe("live");
    expect(savedTrack?.height).toBe(90);

    const video = host.locator("video");
    await video.evaluate((element: HTMLVideoElement) => {
      element.loop = false;
    });
    await expect(video).toHaveJSProperty("ended", true, { timeout: 10_000 });
    await host.getByRole("button", { name: "播放", exact: true }).click();

    expect(hostCrashed, "重播後房主分頁不可崩潰").toBe(false);
    await expectPlaying(viewer);
    await expectAudioPlaying(viewer);
    await expectPeers(host, 1, 1);

    const sameTrack = await host.evaluate(() => {
      const pc = window.observedPeers.find(
        (peer) => peer.signalingState !== "closed",
      );
      const videoSender = pc
        ?.getSenders()
        .find((sender) => sender.track?.kind === "video");
      return {
        sameObject:
          Boolean(window.bug004VideoTrack) &&
          videoSender?.track === window.bug004VideoTrack,
        readyState: videoSender?.track?.readyState ?? null,
      };
    });
    expect(sameTrack).toEqual({ sameObject: true, readyState: "live" });
  });
});
