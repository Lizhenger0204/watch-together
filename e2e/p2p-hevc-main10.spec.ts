import { expect } from "@playwright/test";
import {
  createHostRoom,
  installCaptureAudit,
  installFirstFrameGate,
  joinViewer,
  readCaptureAudit,
  requireNativeHevc,
  type GlobalWithMediaStreams,
} from "./hevc-main10-helpers";
import {
  expectAudioPlaying,
  expectPeers,
  expectPlaying,
  observePeers,
} from "./p2p-media";
import { startLive } from "./p2p-room";
import { test } from "./room-pages";
import { fixture } from "./source-media";

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

  const main10Path = await requireNativeHevc(
    host,
    "hevc-main10-aac.mp4",
    testInfo,
  );

  await test.step("房主選 Main 10 片源開播，收看端正常出畫且房主分頁未崩潰", async () => {
    const invite = await createHostRoom(host);

    await host.getByLabel("選擇影片").setInputFiles(main10Path);
    await expect(host.getByRole("status")).toHaveText("檢查通過，可以播放。");

    await host.locator("video").evaluate((video: HTMLVideoElement) => {
      video.loop = true;
    });
    await host.getByRole("button", { name: "播放", exact: true }).click();
    await startLive(host, "hevc-main10-aac");

    await joinViewer(viewer, invite);

    expect(hostCrashed, "房主分頁不可在送出 Main 10 畫面時崩潰").toBe(false);
    await expectPlaying(viewer);
    await expectPeers(host, 1, 1);

    const conversion = host.getByTestId("source-conversion");
    await expect(conversion).toHaveAttribute("data-converted", "true");
    await expect(conversion).toContainText("10-bit 片源，送出前轉為 8-bit");
  });

  await test.step("自然播完後重播，送出的 video track 物件不變且收看端影格與音訊持續前進", async () => {
    const savedTrack = await host.evaluate(() => {
      const scope = window as GlobalWithMediaStreams;
      const pc = window.observedPeers.find(
        (peer) => peer.signalingState !== "closed",
      );
      const videoSender = pc
        ?.getSenders()
        .find((sender) => sender.track?.kind === "video");
      scope.bug004VideoTrack = videoSender?.track ?? null;
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
      const scope = window as GlobalWithMediaStreams;
      const pc = window.observedPeers.find(
        (peer) => peer.signalingState !== "closed",
      );
      const videoSender = pc
        ?.getSenders()
        .find((sender) => sender.track?.kind === "video");
      return {
        sameObject:
          Boolean(scope.bug004VideoTrack) &&
          videoSender?.track === scope.bug004VideoTrack,
        readyState: videoSender?.track?.readyState ?? null,
      };
    });
    expect(sameTrack).toEqual({ sameObject: true, readyState: "live" });
  });
});

test("連續換片（Main 10 mp4 → Main 8 mp4 → Main 10 mkv）與離開房間後，所有舊擷取 track 皆為 ended", async ({
  newRoomPage,
}, testInfo) => {
  const [host, viewer] = await Promise.all([newRoomPage(), newRoomPage()]);
  await Promise.all([host, viewer].map(observePeers));
  await installCaptureAudit(host);
  await host.goto("/");

  const main10Mp4 = await requireNativeHevc(
    host,
    "hevc-main10-aac.mp4",
    testInfo,
  );
  const main10Mkv = await requireNativeHevc(
    host,
    "hevc-main10-aac.mkv",
    testInfo,
  );
  const main8Mp4 = fixture("hevc-aac.mp4");

  const selectAndPlay = async (
    label: string,
    path: string,
    converted: boolean,
  ) => {
    await host.evaluate((name) => {
      const audit = (window as GlobalWithMediaStreams).bug004Audit;
      if (audit) audit.selection = name;
    }, label);
    await host.getByLabel("選擇影片").setInputFiles(path);
    await expect(
      host.getByText("檢查通過，可以播放。", { exact: true }),
    ).toBeVisible();
    await expect(host.getByTestId("source-conversion")).toHaveAttribute(
      "data-converted",
      String(converted),
    );
    await host.locator("video").evaluate((video: HTMLVideoElement) => {
      video.loop = true;
    });
    await host.getByRole("button", { name: "播放", exact: true }).click();
  };

  const invite = await createHostRoom(host);
  await selectAndPlay("hevc-main10-aac.mp4", main10Mp4, true);
  await startLive(host, "hevc-main10-aac");
  await joinViewer(viewer, invite);
  await expectPlaying(viewer);
  await expectAudioPlaying(viewer);

  await test.step("換成 Main 8 mp4 後，舊擷取 stream 所有 track 皆 ended，只有當下片源為 live", async () => {
    await selectAndPlay("hevc-aac.mp4", main8Mp4, false);
    await expectPlaying(viewer);
    await expectAudioPlaying(viewer);

    const audit = await readCaptureAudit(host);
    expect(audit.captures).toHaveLength(2);
    expect(
      audit.captures[0]?.filter((track) => track.state !== "ended"),
      "第 1 份已退役的擷取 stream 不可殘留 live track",
    ).toEqual([]);
    expect(
      audit.captures[1]?.some(
        (track) => track.kind === "video" && track.state === "live",
      ),
    ).toBe(true);
    expect(
      audit.captures[1]?.some(
        (track) => track.kind === "audio" && track.state === "live",
      ),
    ).toBe(true);
    expect(audit.generators).toHaveLength(1);
    expect(audit.generators[0]?.state).toBe("ended");
  });

  await test.step("再換成 Main 10 mkv 後，前兩份舊 stream 皆無 live track，僅當下片源為 live", async () => {
    await selectAndPlay("hevc-main10-aac.mkv", main10Mkv, true);
    await expectPlaying(viewer);
    await expectAudioPlaying(viewer);

    const audit = await readCaptureAudit(host);
    expect(audit.captures).toHaveLength(3);
    expect(
      audit.captures
        .slice(0, 2)
        .flat()
        .filter((track) => track.state !== "ended"),
      "前 2 份已退役的擷取 stream 不可殘留 live track",
    ).toEqual([]);
    expect(
      audit.captures[2]?.some(
        (track) => track.kind === "video" && track.state === "live",
      ),
    ).toBe(true);
    expect(
      audit.captures[2]?.some(
        (track) => track.kind === "audio" && track.state === "live",
      ),
    ).toBe(true);
    expect(audit.generators.map((track) => track.state)).toEqual([
      "ended",
      "live",
    ]);
  });

  await test.step("離開房間後，所有曾擷取過的 track 與 generator 都是 ended", async () => {
    host.once("dialog", (dialog) => void dialog.accept());
    await host.getByRole("button", { name: "離開房間", exact: true }).click();
    await expect(
      host.getByRole("button", { name: "建立房間", exact: true }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const audit = await readCaptureAudit(host);
        return {
          liveCaptured: audit.captures
            .flat()
            .filter((track) => track.state !== "ended"),
          liveGenerators: audit.generators.filter(
            (track) => track.state !== "ended",
          ),
        };
      })
      .toEqual({ liveCaptured: [], liveGenerators: [] });
  });
});

test("generator 首幀延後時，首幀出來前不顯示「檢查通過」且不交出 stream，首幀出來後才就緒", async ({
  newRoomPage,
}, testInfo) => {
  const [host, viewer] = await Promise.all([newRoomPage(), newRoomPage()]);
  await Promise.all([host, viewer].map(observePeers));
  await installFirstFrameGate(host);
  await host.goto("/");

  const main10Path = await requireNativeHevc(
    host,
    "hevc-main10-aac.mp4",
    testInfo,
  );
  const main8Path = fixture("hevc-aac.mp4");

  const invite = await createHostRoom(host);

  await test.step("未開播房間：首幀被擋住超過試播時間時維持檢查中、不啟用開播；放行後才通過", async () => {
    await host.evaluate(() => {
      (window as GlobalWithMediaStreams).bug004Gate?.arm();
    });
    await host.getByLabel("選擇影片").setInputFiles(main10Path);

    // 等首幀已進入攔截點，且試播時間已超過 1 秒（若沒有等首幀就會提早 ready）。
    await host.waitForFunction(() => {
      const scope = window as GlobalWithMediaStreams;
      const video = document.querySelector("video");
      const conversion = document.querySelector(
        '[data-testid="source-conversion"]',
      );
      return (
        Boolean(scope.bug004Gate?.held) &&
        ((video?.currentTime ?? 0) >= 1.5 || Boolean(conversion))
      );
    });

    await expect(
      host.getByText("正在檢查影片…", { exact: true }),
    ).toBeVisible();
    await expect(
      host.getByText("檢查通過，可以播放。", { exact: true }),
    ).toHaveCount(0);
    await expect(host.getByTestId("source-conversion")).toHaveCount(0);
    await expect(
      host.getByRole("button", { name: "開始直播", exact: true }),
    ).toBeDisabled();
    await expect(
      host.getByRole("button", { name: "播放", exact: true }),
    ).toBeDisabled();

    await host.evaluate(() => {
      (window as GlobalWithMediaStreams).bug004Gate?.release();
    });

    await expect(
      host.getByText("檢查通過，可以播放。", { exact: true }),
    ).toBeVisible();
    await expect(host.getByTestId("source-conversion")).toHaveAttribute(
      "data-converted",
      "true",
    );
    await expect(
      host.getByRole("button", { name: "開始直播", exact: true }),
    ).toBeEnabled();
    const generatorHeight = await host.evaluate(
      () =>
        (window as GlobalWithMediaStreams).bug004Gate?.generators
          .at(-1)
          ?.getSettings().height,
    );
    expect(generatorHeight).toBe(90);
  });

  await test.step("直播中換成 Main 10：首幀出來前不交出 stream（sender.track 為 null），放行後才交出", async () => {
    await host.locator("video").evaluate((video: HTMLVideoElement) => {
      video.loop = true;
    });
    await host.getByRole("button", { name: "播放", exact: true }).click();
    await startLive(host, "hevc-main10-aac");
    await joinViewer(viewer, invite);
    await expectPlaying(viewer);

    // 先切到 8-bit 確認直播連線穩定，再攔截下一次 Main 10 換片的首幀。
    await host.getByLabel("選擇影片").setInputFiles(main8Path);
    await expect(
      host.getByText("檢查通過，可以播放。", { exact: true }),
    ).toBeVisible();
    await expect(host.getByTestId("source-conversion")).toHaveAttribute(
      "data-converted",
      "false",
    );

    await host.evaluate(() => {
      (window as GlobalWithMediaStreams).bug004Gate?.arm();
    });
    await host.getByLabel("選擇影片").setInputFiles(main10Path);

    await host.waitForFunction(() => {
      const scope = window as GlobalWithMediaStreams;
      const video = document.querySelector("video");
      const conversion = document.querySelector(
        '[data-testid="source-conversion"]',
      );
      return (
        Boolean(scope.bug004Gate?.held) &&
        ((video?.currentTime ?? 0) >= 1.5 || Boolean(conversion))
      );
    });

    await expect(
      host.getByText("正在檢查影片…", { exact: true }),
    ).toBeVisible();
    await expect(
      host.getByText("檢查通過，可以播放。", { exact: true }),
    ).toHaveCount(0);
    await expect(host.getByTestId("source-conversion")).toHaveCount(0);
    const senderTrackWhileHeld = await host.evaluate(() => {
      const pc = window.observedPeers.find(
        (peer) => peer.signalingState !== "closed",
      );
      const sender = pc
        ?.getSenders()
        .find((candidate) => candidate.track?.kind === "video");
      return sender?.track?.id ?? null;
    });
    expect(
      senderTrackWhileHeld,
      "首幀輸出前不可把 converter stream 交給房間與傳輸層",
    ).toBeNull();

    await host.evaluate(() => {
      (window as GlobalWithMediaStreams).bug004Gate?.release();
    });

    await expect(
      host.getByText("檢查通過，可以播放。", { exact: true }),
    ).toBeVisible();
    await expect(host.getByTestId("source-conversion")).toHaveAttribute(
      "data-converted",
      "true",
    );
    await expect
      .poll(() =>
        host.evaluate(() => {
          const scope = window as GlobalWithMediaStreams;
          const latestGenerator = scope.bug004Gate?.generators.at(-1);
          const pc = window.observedPeers.find(
            (peer) => peer.signalingState !== "closed",
          );
          const sender = pc
            ?.getSenders()
            .find((candidate) => candidate.track?.kind === "video");
          return {
            sameAsGenerator:
              Boolean(latestGenerator) && sender?.track === latestGenerator,
            height: sender?.track?.getSettings().height ?? null,
          };
        }),
      )
      .toEqual({ sameAsGenerator: true, height: 90 });

    await host.locator("video").evaluate((video: HTMLVideoElement) => {
      video.loop = true;
    });
    await host.getByRole("button", { name: "播放", exact: true }).click();
    await expectPlaying(viewer);
  });
});
