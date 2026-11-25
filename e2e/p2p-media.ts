import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    observedPeers: RTCPeerConnection[];
  }
}

export async function observePeers(page: Page) {
  await page.addInitScript(() => {
    window.observedPeers = [];
    window.RTCPeerConnection = class extends RTCPeerConnection {
      constructor(config?: RTCConfiguration) {
        super(config);
        window.observedPeers.push(this);
      }
    };
  });
}

export async function expectPeers(page: Page, open: number, created?: number) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        open: window.observedPeers.filter(
          (pc) => pc.signalingState !== "closed",
        ).length,
        created: window.observedPeers.length,
      })),
    )
    .toMatchObject(created === undefined ? { open } : { open, created });
}

async function playbackSample(page: Page) {
  return page.locator("video").evaluate((video: HTMLVideoElement) => {
    const quality = video.getVideoPlaybackQuality();
    return {
      frames: quality.totalVideoFrames - quality.droppedVideoFrames,
      time: video.currentTime,
      playing: !video.paused && video.videoWidth > 0,
    };
  });
}

export async function expectPlaying(...pages: Page[]) {
  await Promise.all(
    pages.map(async (page) => {
      // 換片、重播時播放器可能仍顯示上一格，須等到取樣後連續呈現多格。
      await expect
        .poll(async () => (await playbackSample(page)).playing)
        .toBe(true);
      const before = await playbackSample(page);
      await expect
        .poll(async () => {
          const now = await playbackSample(page);
          return {
            playing: now.playing,
            timeAdvanced: now.time > before.time + 0.25,
            framesAdvanced: now.frames >= before.frames + 8,
          };
        })
        .toEqual({ playing: true, timeAdvanced: true, framesAdvanced: true });
    }),
  );
}

function receivedAudio(page: Page) {
  return page.locator("video").evaluate(async (video: HTMLVideoElement) => {
    const stream = video.srcObject;
    const track =
      stream instanceof MediaStream ? stream.getAudioTracks()[0] : null;
    if (track?.readyState !== "live" || track.muted) return null;
    const receiver = window.observedPeers
      .filter((pc) => pc.connectionState === "connected")
      .flatMap((pc) => pc.getReceivers())
      .find((item) => item.track === track);
    const report = await receiver?.getStats();
    for (const stat of report?.values() ?? []) {
      if (stat.type === "inbound-rtp" && stat.kind === "audio") {
        return {
          packets: Number(stat.packetsReceived),
          energy: Number(stat.totalAudioEnergy),
        };
      }
    }
    return null;
  });
}

export async function expectAudioPlaying(...pages: Page[]) {
  await Promise.all(
    pages.map(async (page) => {
      await expect
        .poll(async () => (await receivedAudio(page))?.packets ?? 0)
        .toBeGreaterThan(0);
      const before = await receivedAudio(page);
      expect(before).not.toBeNull();
      await expect
        .poll(
          async () => {
            const now = await receivedAudio(page);
            return (
              !!now &&
              !!before &&
              now.packets > before.packets &&
              now.energy > before.energy
            );
          },
          { message: "播放器的音軌持續收到含聲音的 RTP 封包" },
        )
        .toBe(true);
    }),
  );
}

export async function beginWatching(page: Page) {
  const start = page.getByRole("button", { name: /點擊開始觀看/ });
  await expect(start).toBeVisible();
  // 等媒體確實到達，避免還沒接上 stream 就檢查 paused 而誤判通過。
  await expect
    .poll(async () => (await receivedAudio(page))?.packets ?? 0)
    .toBeGreaterThan(0);
  const video = page.locator("video");
  await expect(video).toHaveJSProperty("paused", true);
  await start.click();
  await expect(video).toHaveJSProperty("muted", false);
  await expectAudioPlaying(page);
}
