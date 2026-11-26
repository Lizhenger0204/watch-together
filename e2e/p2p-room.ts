import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { submitJoin } from "./join-room";
import {
  beginWatching,
  expectPeers,
  expectPlaying,
  observePeers,
} from "./p2p-media";
import type { NewRoomPage } from "./room-pages";

export async function playMovie(
  host: Page,
  name: "h264-aac" | "h264-silent" | "h264-2160p-aac",
) {
  await host
    .getByLabel("選擇影片")
    .setInputFiles(
      fileURLToPath(new URL(`./fixtures/${name}.mp4`, import.meta.url)),
    );
  if (name === "h264-silent") {
    await host.getByRole("button", { name: "繼續播放無聲影片" }).click();
    await expect(host.getByText("可以播放（無聲）")).toBeVisible();
  } else {
    await expect(host.getByText("檢查通過，可以播放。")).toBeVisible();
  }
  await host.locator("video").evaluate((video: HTMLVideoElement) => {
    video.loop = true;
  });
  await host.getByRole("button", { name: "播放", exact: true }).click();
}

export async function startLive(host: Page, title: string) {
  await host.getByRole("button", { name: "開始直播", exact: true }).click();
  await expect(
    host.getByRole("heading", { name: `直播中：${title}`, exact: true }),
  ).toBeVisible();
}

export async function expectWaiting(...pages: Page[]) {
  await Promise.all(
    pages.map(async (page) => {
      await expect(
        page.getByText("等待 房主 開始播放…", { exact: true }),
      ).toBeVisible();
      await expectPeers(page, 0);
    }),
  );
}

export async function openLiveRoom(newRoomPage: NewRoomPage) {
  const [host, first, second] = await Promise.all([
    newRoomPage(),
    newRoomPage(),
    newRoomPage(),
  ]);
  const viewers = [first, second] as const;
  await Promise.all([host, ...viewers].map(observePeers));
  await host.goto("/");
  await host.getByLabel("你的暱稱").first().fill("房主");
  await host.getByRole("button", { name: "建立房間", exact: true }).click();
  const code = host.getByTestId("invite-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const invite = await code.innerText();
  await playMovie(host, "h264-aac");
  await startLive(host, "h264-aac");
  await Promise.all(
    viewers.map(async (viewer, index) => {
      await viewer.goto("/");
      const join = viewer
        .locator("form")
        .filter({ has: viewer.getByLabel("邀請碼") });
      await join.getByLabel("邀請碼").fill(invite);
      await join.getByLabel("你的暱稱").fill(index === 0 ? "朋友甲" : "朋友乙");
      await submitJoin(
        viewer,
        join.getByRole("button", { name: "加入", exact: true }),
      );
      await beginWatching(viewer);
    }),
  );
  await expectPlaying(...viewers);
  await expectPeers(host, 2, 2);
  return { host, viewers };
}
