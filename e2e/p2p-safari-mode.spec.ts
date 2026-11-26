import { expect, type Page } from "@playwright/test";
import { submitJoin } from "./join-room";
import {
  beginWatching,
  expectPeers,
  expectPlaying,
  observePeers,
} from "./p2p-media";
import { playMovie, startLive } from "./p2p-room";
import { createRelaySfu } from "./relay-sfu";
import { test } from "./room-pages";

// 房主端「Safari 模式」（streaming.md §2）：直播中切換，現有 P2P 連線重新協商到
// H.264 Constrained Baseline（macOS Chrome 為 OpenH264），播放不中斷、不重建連線。

// 假裝置讓房主頁取得鏡頭權限，getStats() 才會提供 encoderImplementation（ADR 0004 實測 1）。
test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
});

declare global {
  interface Window {
    __encoderPermission?: MediaStream;
    __sawConnecting?: boolean;
  }
}

interface HostVideo {
  profile: string | null;
  encoder: string | null;
  bytesSent: number;
}

function hostVideo(host: Page): Promise<HostVideo[]> {
  return host.evaluate(async () => {
    const out: HostVideo[] = [];
    for (const pc of window.observedPeers) {
      if (pc.signalingState === "closed") continue;
      const report = await pc.getStats();
      const stats = [...report.values()] as Record<string, unknown>[];
      const video = stats.find(
        (s) => s.type === "outbound-rtp" && s.kind === "video",
      );
      const codec = stats.find((s) => s.id === video?.codecId);
      const fmtp =
        typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : "";
      out.push({
        profile: /profile-level-id=([0-9a-f]{6})/i.exec(fmtp)?.[1] ?? null,
        encoder:
          typeof video?.encoderImplementation === "string"
            ? video.encoderImplementation
            : null,
        bytesSent: Number(video?.bytesSent ?? 0),
      });
    }
    return out;
  });
}

/** 收看端開始記錄播放器是否出現過「連線中…」提示。 */
function watchConnectingNotice(viewer: Page) {
  return viewer.evaluate(() => {
    window.__sawConnecting = false;
    const check = () => {
      if (document.body.innerText.includes("連線中…"))
        window.__sawConnecting = true;
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

async function expectPath(host: Page, profile: RegExp, encoder: string | null) {
  await expect
    .poll(
      async () =>
        (await hostVideo(host)).map((v) => ({
          profile: v.profile?.toLowerCase() ?? null,
          encoder: encoder === null ? null : v.encoder,
        })),
      { timeout: 15_000 },
    )
    .toEqual([{ profile: expect.stringMatching(profile), encoder }]);
}

/** 房主以 4K fixture（預設 1080P，送出走硬體編碼的解析度）開播，一位收看者觀看。 */
async function liveRoom(newRoomPage: () => Promise<Page>) {
  const [host, viewer] = await Promise.all([newRoomPage(), newRoomPage()]);
  await Promise.all([observePeers(host), observePeers(viewer)]);

  await host.goto("/");
  await host.context().grantPermissions(["camera", "microphone"]);
  await host.evaluate(async () => {
    window.__encoderPermission = await navigator.mediaDevices.getUserMedia({
      video: true,
    });
  });
  await host.getByLabel("你的暱稱").first().fill("房主");
  await host.getByRole("button", { name: "建立房間", exact: true }).click();
  const code = host.getByTestId("invite-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const invite = await code.innerText();
  // 160×90 的小片 Chrome 本來就走 OpenH264，要用 4K 片源縮到 1080P 才看得出硬體／軟體差別。
  await playMovie(host, "h264-2160p-aac");
  await startLive(host, "h264-2160p-aac");

  await viewer.goto("/");
  const join = viewer
    .locator("form")
    .filter({ has: viewer.getByLabel("邀請碼") });
  await join.getByLabel("邀請碼").fill(invite);
  await join.getByLabel("你的暱稱").fill("朋友");
  await submitJoin(
    viewer,
    join.getByRole("button", { name: "加入", exact: true }),
  );
  await beginWatching(viewer);
  await expectPlaying(viewer);
  return { host, viewer };
}

function safariSwitch(host: Page) {
  return host
    .getByRole("dialog", { name: "畫質" })
    .getByRole("switch", { name: "Safari 模式" });
}

const releaseEncoderPermission = (host: Page) =>
  host.evaluate(() => {
    window.__encoderPermission?.getTracks().forEach((t) => t.stop());
  });

// macOS Chrome：Baseline 42001f 走硬體 VideoToolbox，Constrained Baseline 42e01f 走 OpenH264。
const mac = process.platform === "darwin";

test("直播中開關 Safari 模式：重新協商換 profile 與編碼器，播放不中斷、不重建連線", async ({
  newRoomPage,
}) => {
  test.setTimeout(90_000);
  const { host, viewer } = await liveRoom(newRoomPage);
  await expectPeers(host, 1, 1);
  await expectPath(host, /^4200[0-9a-f]{2}$/, mac ? "VideoToolbox" : null);

  await host.getByRole("button", { name: /^畫質/ }).click();
  const toggle = safariSwitch(host);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(
    host.getByRole("dialog", { name: "畫質" }).getByText("改用軟體編碼"),
  ).toBeVisible();

  await watchConnectingNotice(viewer);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expectPath(host, /^42e0[0-9a-f]{2}$/, mac ? "OpenH264" : null);
  await expectPlaying(viewer);
  const before = (await hostVideo(host))[0]!.bytesSent;
  await expect
    .poll(async () => (await hostVideo(host))[0]!.bytesSent)
    .toBeGreaterThan(before);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expectPath(host, /^4200[0-9a-f]{2}$/, mac ? "VideoToolbox" : null);
  await expectPlaying(viewer);

  // 同一條連線上重新協商：兩端都沒有新建 RTCPeerConnection，收看端也沒出現「連線中…」。
  await expectPeers(host, 1, 1);
  await expectPeers(viewer, 1, 1);
  expect(await viewer.evaluate(() => window.__sawConnecting)).toBe(false);
  await releaseEncoderPermission(host);
});

test("轉發模式開關 Safari 模式：不重新 WHIP，以 encodings codec 切換 profile 與編碼器，收看端持續播放", async ({
  browser,
  newRoomPage,
}) => {
  test.setTimeout(90_000);
  const sfu = await createRelaySfu(browser);
  try {
    const { host, viewer } = await liveRoom(newRoomPage);
    await sfu.attach(host, "host");
    await sfu.attach(viewer, "viewer");
    const relay = host.getByRole("button", { name: "轉發", exact: true });
    await relay.click();
    await expect(relay).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => sfu.stats().whep.length).toBe(1);
    await expectPeers(host, 1);
    await expectPlaying(viewer);
    await expectPath(host, /^4200[0-9a-f]{2}$/, mac ? "VideoToolbox" : null);

    await host.getByRole("button", { name: /^畫質/ }).click();
    const toggle = safariSwitch(host);
    await toggle.click();
    await expectPath(host, /^42e0[0-9a-f]{2}$/, mac ? "OpenH264" : null);
    await expectPlaying(viewer);

    await toggle.click();
    await expectPath(host, /^4200[0-9a-f]{2}$/, mac ? "VideoToolbox" : null);
    await expectPlaying(viewer);

    // WHIP 不能重新協商：整段只有一次發布、沒有刪除，也沒有顯示錯誤。
    expect(sfu.stats()).toMatchObject({ whipRequests: 1, whepRequests: 1 });
    expect(sfu.stats().deleteRequests).toEqual([]);
    await expect(host.getByText("無法立即切換 Safari 模式")).toHaveCount(0);
    // P2P 的 1 條 + 轉發的 1 條。
    await expectPeers(host, 1, 2);
    await releaseEncoderPermission(host);
  } finally {
    await sfu.close();
  }
});
