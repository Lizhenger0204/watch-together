import { expect, type Page } from "@playwright/test";
import { submitJoin } from "./join-room";
import {
  beginWatching,
  expectPeers,
  expectPlaying,
  observePeers,
} from "./p2p-media";
import { playMovie, startLive } from "./p2p-room";
import { test } from "./room-pages";

/**
 * 模擬 Safari／WebKit 接收端 H.264 能力：只保留 Constrained Baseline（42e0xx）與
 * Constrained High（640cxx），移除 Chrome 排在第一位的 Baseline（4200xx）、Main（4d00xx）
 * 與 High（6400xx）。未修正時房主會對此收看者退回 42e01f（軟體 OpenH264），而對一般
 * Chrome 走 42001f（硬體 VideoToolbox），造成不同協商 profile 與約 2 倍位元率落差。
 */
async function restrictViewerToConstrainedBaseline(page: Page) {
  await page.addInitScript(() => {
    const origSetRemote = window.RTCPeerConnection.prototype
      .setRemoteDescription as (
      this: RTCPeerConnection,
      description: RTCSessionDescriptionInit,
    ) => Promise<void>;
    window.RTCPeerConnection.prototype.setRemoteDescription = async function (
      desc: RTCSessionDescriptionInit,
    ) {
      await origSetRemote.call(this, desc);
      if (desc?.type !== "offer") return;
      const recv = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
      const isSafariH264 = (codec: RTCRtpCodec) => {
        if (codec.mimeType.toLowerCase() !== "video/h264") return false;
        const fmtp = (codec.sdpFmtpLine ?? "").toLowerCase();
        return (
          fmtp.includes("profile-level-id=42e0") ||
          fmtp.includes("profile-level-id=640c")
        );
      };
      // 依 Safari 實際接收端順序：只留 42e0xx／640cxx H.264 並排在最前，其餘非 H.264（VP8、rtx 等）在後。
      const safariLike = [
        ...recv.filter(isSafariH264),
        ...recv.filter(
          (codec) => codec.mimeType.toLowerCase() !== "video/h264",
        ),
      ];
      for (const transceiver of this.getTransceivers()) {
        if (transceiver.receiver.track?.kind === "video") {
          transceiver.setCodecPreferences(safariLike);
        }
      }
    };
  });
}

interface OutboundVideoSample {
  mimeType: string | null;
  sdpFmtpLine: string | null;
  bytesSent: number;
  timestamp: number;
  frameHeight: number;
  framesPerSecond: number;
  maxBitrate: number | null;
  scaleResolutionDownBy: number | null;
}

function sampleHostOutboundVideos(host: Page): Promise<OutboundVideoSample[]> {
  return host.evaluate(async () => {
    const results: OutboundVideoSample[] = [];
    for (const pc of window.observedPeers) {
      if (pc.signalingState === "closed") continue;
      const report = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      for (const stat of report.values()) {
        byId.set(stat.id as string, stat as Record<string, unknown>);
      }
      let video: Record<string, unknown> | undefined;
      for (const stat of report.values()) {
        if (
          stat.type === "outbound-rtp" &&
          (stat.kind === "video" || stat.mediaType === "video")
        ) {
          video = stat as Record<string, unknown>;
        }
      }
      const codec =
        typeof video?.codecId === "string"
          ? byId.get(video.codecId)
          : undefined;
      const sender = pc
        .getSenders()
        .find((candidate) => candidate.track?.kind === "video");
      const encoding = sender?.getParameters().encodings[0];
      results.push({
        mimeType: typeof codec?.mimeType === "string" ? codec.mimeType : null,
        sdpFmtpLine:
          typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : null,
        bytesSent: Number(video?.bytesSent ?? 0),
        timestamp: Number(video?.timestamp ?? 0),
        frameHeight: Number(video?.frameHeight ?? 0),
        framesPerSecond: Number(video?.framesPerSecond ?? 0),
        maxBitrate: encoding?.maxBitrate ?? null,
        scaleResolutionDownBy: encoding?.scaleResolutionDownBy ?? null,
      });
    }
    return results;
  });
}

function viewerInboundCodec(viewer: Page) {
  return viewer.evaluate(async () => {
    for (const pc of window.observedPeers) {
      if (pc.connectionState !== "connected") continue;
      const report = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      for (const stat of report.values()) {
        byId.set(stat.id as string, stat as Record<string, unknown>);
      }
      for (const stat of report.values()) {
        if (
          stat.type === "inbound-rtp" &&
          (stat.kind === "video" || stat.mediaType === "video")
        ) {
          const codec =
            typeof stat.codecId === "string"
              ? byId.get(stat.codecId)
              : undefined;
          return {
            mimeType:
              typeof codec?.mimeType === "string" ? codec.mimeType : null,
            sdpFmtpLine:
              typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : null,
            frameHeight: Number(stat.frameHeight ?? 0),
            framesDecoded: Number(stat.framesDecoded ?? 0),
          };
        }
      }
    }
    return null;
  });
}

function extractProfile(fmtp: string | null): string | null {
  if (!fmtp) return null;
  const match = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp);
  return match ? match[1]!.toLowerCase() : null;
}

test("P2P 多收看者（模擬 Safari 僅支援 42e01f 與標準 Chrome）：房主協商同一 H.264 profile 且穩態位元率一致", async ({
  newRoomPage,
}, testInfo) => {
  test.setTimeout(90_000);
  const [host, safariLike, standardChrome] = await Promise.all([
    newRoomPage(),
    newRoomPage(),
    newRoomPage(),
  ]);
  await Promise.all([
    observePeers(host),
    observePeers(safariLike),
    observePeers(standardChrome),
  ]);
  await restrictViewerToConstrainedBaseline(safariLike);

  await host.goto("/");
  await host.getByLabel("你的暱稱").first().fill("房主");
  await host.getByRole("button", { name: "建立房間", exact: true }).click();
  const code = host.getByTestId("invite-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const invite = await code.innerText();

  // 使用 4K 片源搭配預設畫質（1080P／8 Mbps／30 FPS）：未修正前兩路會因編碼器不同拉開近 2 倍位元率差距。
  await playMovie(host, "h264-2160p-aac");
  await startLive(host, "h264-2160p-aac");

  // 先讓模擬 Safari 收看者加入，再讓標準 Chrome 收看者加入。
  for (const [viewer, nickname] of [
    [safariLike, "模擬Safari"],
    [standardChrome, "標準Chrome"],
  ] as const) {
    await viewer.goto("/");
    const join = viewer
      .locator("form")
      .filter({ has: viewer.getByLabel("邀請碼") });
    await join.getByLabel("邀請碼").fill(invite);
    await join.getByLabel("你的暱稱").fill(nickname);
    await submitJoin(
      viewer,
      join.getByRole("button", { name: "加入", exact: true }),
    );
    await beginWatching(viewer);
  }

  await expectPlaying(safariLike, standardChrome);
  await expectPeers(host, 2, 2);

  // 等待兩條連線都開始以 H.264 穩定送出（高度達 ≥720p 且 FPS ≥ 20）。
  await expect
    .poll(
      async () => {
        const list = await sampleHostOutboundVideos(host);
        return list.map((item) => ({
          mime: item.mimeType?.toLowerCase() ?? null,
          profile: extractProfile(item.sdpFmtpLine),
          heightOk: item.frameHeight >= 720,
          fpsOk: item.framesPerSecond >= 20,
        }));
      },
      {
        timeout: 25_000,
        message: "兩條房主連線都應以 H.264 穩定送出影音",
      },
    )
    .toEqual([
      {
        mime: "video/h264",
        profile: expect.stringMatching(/^4200[0-9a-f]{2}$/),
        heightOk: true,
        fpsOk: true,
      },
      {
        mime: "video/h264",
        profile: expect.stringMatching(/^4200[0-9a-f]{2}$/),
        heightOk: true,
        fpsOk: true,
      },
    ]);

  // 給頻寬估計與畫質爬坡 8 秒進入穩態，再量測 6 秒區間平均位元率。
  await host.waitForTimeout(8_000);
  const before = await sampleHostOutboundVideos(host);
  await host.waitForTimeout(6_000);
  const after = await sampleHostOutboundVideos(host);

  expect(before).toHaveLength(2);
  expect(after).toHaveLength(2);

  const [aBefore, bBefore] = before as [
    OutboundVideoSample,
    OutboundVideoSample,
  ];
  const [aAfter, bAfter] = after as [OutboundVideoSample, OutboundVideoSample];

  // 1. 兩條房主連線必須協商到完全相同的 codec、profile-level-id 與編碼參數。
  expect(aAfter.mimeType?.toLowerCase()).toBe("video/h264");
  expect(bAfter.mimeType?.toLowerCase()).toBe("video/h264");
  const hostProfileA = extractProfile(aAfter.sdpFmtpLine);
  const hostProfileB = extractProfile(bAfter.sdpFmtpLine);
  expect(hostProfileA).not.toBeNull();
  expect(hostProfileA).toBe(hostProfileB);
  expect(aAfter.sdpFmtpLine).toContain("packetization-mode=1");
  expect(bAfter.sdpFmtpLine).toContain("packetization-mode=1");
  expect(aAfter.maxBitrate).toBe(8_000_000);
  expect(bAfter.maxBitrate).toBe(8_000_000);
  expect(aAfter.scaleResolutionDownBy).toBe(2);
  expect(bAfter.scaleResolutionDownBy).toBe(2);

  // 2. 兩位收看者端都收到同一個 H.264 Constrained Baseline profile（42e0xx）且正常解碼 1080p。
  const [vSafari, vChrome] = await Promise.all([
    viewerInboundCodec(safariLike),
    viewerInboundCodec(standardChrome),
  ]);
  expect(vSafari?.mimeType?.toLowerCase()).toBe("video/h264");
  expect(vChrome?.mimeType?.toLowerCase()).toBe("video/h264");
  expect(extractProfile(vSafari?.sdpFmtpLine ?? null)).toMatch(
    /^42e0[0-9a-f]{2}$/,
  );
  expect(extractProfile(vChrome?.sdpFmtpLine ?? null)).toBe(
    extractProfile(vSafari?.sdpFmtpLine ?? null),
  );
  expect(vSafari?.frameHeight ?? 0).toBeGreaterThanOrEqual(720);
  expect(vChrome?.frameHeight ?? 0).toBeGreaterThanOrEqual(720);
  expect(vSafari?.framesDecoded ?? 0).toBeGreaterThan(30);
  expect(vChrome?.framesDecoded ?? 0).toBeGreaterThan(30);

  // 3. 穩態位元率兩路均大於 1.5 Mbps，且差距在合理誤差內（≤ 1.45 倍）。
  const rateA =
    ((aAfter.bytesSent - aBefore.bytesSent) * 8) /
    (aAfter.timestamp - aBefore.timestamp);
  const rateB =
    ((bAfter.bytesSent - bBefore.bytesSent) * 8) /
    (bAfter.timestamp - bBefore.timestamp);
  expect(rateA).toBeGreaterThan(1_500);
  expect(rateB).toBeGreaterThan(1_500);
  const ratio = Math.max(rateA, rateB) / Math.min(rateA, rateB);
  expect(ratio).toBeLessThanOrEqual(1.45);

  const summary = `hostProfiles=[${hostProfileA}, ${hostProfileB}], viewerProfiles=[${extractProfile(vSafari?.sdpFmtpLine ?? null)}, ${extractProfile(vChrome?.sdpFmtpLine ?? null)}], ratesKbps=[${Math.round(rateA)}, ${Math.round(rateB)}], ratio=${ratio.toFixed(2)}`;
  testInfo.annotations.push({ type: "bitrate-fairness", description: summary });
  console.log(summary);
});
