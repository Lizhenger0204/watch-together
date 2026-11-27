import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  checkBrowserErrors,
  expectFramesAdvance,
  fixture,
  nativePlayback,
} from "./source-media";

/**
 * 在真 Chrome 裡模擬 Windows D3D11 對「HEVC 標頭宣告 Main 10、實際 8-bit」的拒絕：
 * - 追蹤所有 URL.createObjectURL(blob) 建立的 Blob 與撤銷紀錄；
 * - 檢查 <video>.src 指向的實際 Blob 位元組：若 hvcC／CodecPrivate 的 general_profile_idc 仍為 2 且 bitDepth === 8，
 *   於試播 play() 時觸發 PIPELINE_ERROR_DECODE（0x80070057）；
 * - 若已被零複製修補成 general_profile_idc === 1（Main），放行交由真 Chrome 原生解碼、播放與擷取。
 */
async function installWindowsD3d11Simulator(
  page: Page,
  options: {
    rejectPatchedToo?: boolean;
    failCaptureAfterFix?: boolean;
  } = {},
) {
  await page.addInitScript(({ rejectPatchedToo, failCaptureAfterFix }) => {
    const urlToBlob = new Map<string, Blob>();
    const revokedUrls = new Set<string>();
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    const state = {
      rejectedMalformed: 0,
      allowedPatched: 0,
      rejectedPatched: 0,
      revokedOriginalCount: 0,
      originalUrls: [] as string[],
    };
    (window as unknown as { __d3d11Sim: typeof state }).__d3d11Sim = state;

    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = origCreate(obj);
      if (obj instanceof Blob) urlToBlob.set(url, obj);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revokedUrls.add(url);
      if (state.originalUrls.includes(url)) state.revokedOriginalCount += 1;
      origRevoke(url);
    };

    function findHvccProfile(bytes: Uint8Array): {
      profileIdc: number;
      bitDepthLuma: number;
    } | null {
      // MP4 hvcC
      for (let i = 4; i + 27 <= bytes.length; i += 1) {
        if (
          bytes[i] === 0x68 &&
          bytes[i + 1] === 0x76 &&
          bytes[i + 2] === 0x63 &&
          bytes[i + 3] === 0x43
        ) {
          const base = i + 4;
          return {
            profileIdc: bytes[base + 1]! & 0x1f,
            bitDepthLuma: (bytes[base + 17]! & 0x07) + 8,
          };
        }
      }
      // MKV CodecPrivate (0x63 0xA2 + VINT size + configurationVersion=1)
      for (let i = 0; i + 26 <= bytes.length; i += 1) {
        if (bytes[i] === 0x63 && bytes[i + 1] === 0xa2) {
          const first = bytes[i + 2]!;
          let vintLen = 1;
          let mask = 0x80;
          while ((first & mask) === 0 && vintLen <= 4) {
            mask >>= 1;
            vintLen += 1;
          }
          const base = i + 2 + vintLen;
          if (base + 23 <= bytes.length && bytes[base] === 1) {
            return {
              profileIdc: bytes[base + 1]! & 0x1f,
              bitDepthLuma: (bytes[base + 17]! & 0x07) + 8,
            };
          }
        }
      }
      return null;
    }

    if (failCaptureAfterFix) {
      const proto = HTMLVideoElement.prototype as HTMLVideoElement & {
        captureStream?: () => MediaStream;
      };
      const origCapture = proto.captureStream;
      if (origCapture) {
        proto.captureStream = function simulatedCapture(
          this: HTMLVideoElement,
        ) {
          if (state.rejectedMalformed > 0) {
            throw new DOMException(
              "Capture failed after fix",
              "InvalidStateError",
            );
          }
          return origCapture.call(this);
        };
      }
    }

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function simulatedPlay(
      this: HTMLMediaElement,
    ) {
      const src = this.currentSrc || this.src;
      const blob = urlToBlob.get(src);
      if (!blob) return origPlay.call(this);

      return blob
        .slice(0, 64 * 1024)
        .arrayBuffer()
        .then((buf) => {
          const parsed = findHvccProfile(new Uint8Array(buf));
          const isMalformed =
            parsed !== null &&
            parsed.profileIdc === 2 &&
            parsed.bitDepthLuma === 8;
          const isPatched =
            parsed !== null &&
            parsed.profileIdc === 1 &&
            parsed.bitDepthLuma === 8;

          if (isMalformed || (rejectPatchedToo && isPatched)) {
            if (isMalformed) {
              state.rejectedMalformed += 1;
              state.originalUrls.push(src);
            } else {
              state.rejectedPatched += 1;
            }
            Object.defineProperty(this, "error", {
              configurable: true,
              value: {
                code: 3,
                message: isMalformed
                  ? "PIPELINE_ERROR_DECODE: GetVideoDecoderConfigCount failed: 參數錯誤。 (0x80070057)"
                  : "PIPELINE_ERROR_DECODE: RETRY_PATCHED_DECODE_FAILED",
              },
            });
            this.dispatchEvent(new Event("error"));
            return Promise.reject(
              new DOMException("Decode failed", "NotSupportedError"),
            );
          }
          if (isPatched) state.allowedPatched += 1;
          return origPlay.call(this);
        });
    };
  }, options);
}

test.beforeEach(async ({ page }) => {
  checkBrowserErrors(page);
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
});

test("does not misclassify malformed Main 10 on 8-bit as true 10-bit (BUG-004)", async ({
  page,
}, testInfo) => {
  await page.goto("/?demo=source");
  // 以正常 Main 8 HEVC 作為平台能力探針，避免會拒播畸形片的平台略過整支測試。
  const native = await nativePlayback(page, fixture("hevc-aac.mp4"), testInfo);
  const decodable =
    native.mediaError === null &&
    native.width > 0 &&
    native.frames > 2 &&
    native.currentTime >= 1;
  test.skip(
    !decodable && process.env.HEVC_REQUIRED !== "1",
    `原生 Chrome 無法解碼 HEVC，略過此驗證（HEVC_REQUIRED=1 可強制執行）。`,
  );
  expect(native.mediaError).toBeNull();
  expect(native.width).toBeGreaterThan(0);

  const input = page.getByLabel("選擇影片");
  const conversion = page.getByTestId("source-conversion");

  // 畸形片在可原生播放平台（如 macOS）直接放行，在拒播平台（如 Windows D3D11）經自動修補放行；
  // 兩者皆不可誤判為真 10-bit（converted 必須是 false）。
  await input.setInputFiles(fixture("hevc-main10-8bit-malformed-aac.mp4"));
  await expect(page.getByRole("status")).toHaveText("檢查通過，可以播放。");
  await expect(conversion).toHaveAttribute("data-converted", "false");
  await expect(conversion).toHaveAttribute(
    "data-header-fixed",
    /^(true|false)$/,
  );

  // 真 10-bit 仍正常走 BUG-004 轉換（converted 必須是 true，且不觸發標頭修補）
  await input.setInputFiles(fixture("hevc-main10-aac.mp4"));
  await expect(page.getByRole("status")).toHaveText("檢查通過，可以播放。");
  await expect(conversion).toHaveAttribute("data-converted", "true");
  await expect(conversion).toHaveAttribute("data-header-fixed", "false");

  // 畸形 MKV 同理：無論原檔直播或自動修補放行，converted 都必須是 false
  await input.setInputFiles(fixture("hevc-main10-8bit-malformed-aac.mkv"));
  await expect(page.getByRole("status")).toHaveText("檢查通過，可以播放。");
  await expect(conversion).toHaveAttribute("data-converted", "false");
  await expect(conversion).toHaveAttribute(
    "data-header-fixed",
    /^(true|false)$/,
  );
});

for (const name of [
  "hevc-main10-8bit-malformed-aac.mp4",
  "hevc-main10-8bit-malformed-aac.mkv",
]) {
  test(`auto-fixes ${name} via zero-copy Blob splice when native decode rejects Main 10 on 8-bit`, async ({
    page,
  }, testInfo) => {
    await page.goto("/?demo=source");
    const native = await nativePlayback(
      page,
      fixture("hevc-main10-8bit-fixed-aac.mp4"),
      testInfo,
    );
    const decodable =
      native.mediaError === null &&
      native.width > 0 &&
      native.frames > 2 &&
      native.currentTime >= 1;
    test.skip(
      !decodable && process.env.HEVC_REQUIRED !== "1",
      `原生 Chrome 無法解碼 HEVC，略過此驗證（HEVC_REQUIRED=1 可強制執行）。`,
    );
    expect(native.mediaError).toBeNull();

    await installWindowsD3d11Simulator(page);
    await page.goto("/?demo=source");

    await page.getByLabel("選擇影片").setInputFiles(fixture(name));
    await expect(page.getByRole("status")).toHaveText("檢查通過，可以播放。");

    const conversion = page.getByTestId("source-conversion");
    await expect(conversion).toHaveAttribute("data-header-fixed", "true");
    await expect(conversion).toHaveAttribute("data-converted", "false");
    await expect(conversion).toContainText(
      "已自動修正 HEVC 標頭（Main 10 → Main，8-bit",
    );
    await expect(page.getByText("擷取音軌 1・擷取影像軌 1")).toBeVisible();

    const sim = await page.evaluate(
      () =>
        (
          window as unknown as {
            __d3d11Sim: {
              rejectedMalformed: number;
              allowedPatched: number;
              revokedOriginalCount: number;
            };
          }
        ).__d3d11Sim,
    );
    expect(sim.rejectedMalformed).toBe(1);
    expect(sim.allowedPatched).toBeGreaterThanOrEqual(1);
    expect(sim.revokedOriginalCount).toBeGreaterThanOrEqual(1);

    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expectFramesAdvance(page, testInfo);
  });
}

test("reports HEVC_PROFILE_MISMATCH with copyable FFmpeg guidance when auto-fix retry still fails", async ({
  page,
}) => {
  await installWindowsD3d11Simulator(page, { rejectPatchedToo: true });
  await page.goto("/?demo=source");

  await page
    .getByLabel("選擇影片")
    .setInputFiles(fixture("hevc-main10-8bit-malformed-aac.mp4"));

  const status = page.getByRole("status");
  await expect(status).toContainText(
    "這支影片的 HEVC 標頭有誤（標成 Main 10／10-bit，實際畫面是 8-bit）",
  );
  await expect(status).not.toContainText("影像無法解碼");
  await expect(
    page.getByRole("button", { name: "播放", exact: true }),
  ).toBeDisabled();

  const guide = page.getByTestId("hevc-mismatch-guide");
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("hevc_nvenc");
  await expect(guide).toContainText("libx265");
  await expect(guide.getByRole("button", { name: "複製指令" })).toHaveCount(2);

  await page.getByText("播放診斷", { exact: true }).click();
  await expect(
    page.getByText(
      "HEVC 標頭：Main 10（實際 8-bit），標頭矛盾；自動修正：自動修正後仍無法解碼",
    ),
  ).toBeVisible();
  // 兩次試播診斷皆須保留：首次原檔（0x80070057）與修補重試（RETRY_PATCHED_DECODE_FAILED）
  await expect(page.getByText("首次原檔試播", { exact: false })).toContainText(
    "0x80070057",
  );
  await expect(
    page.getByText("RETRY_PATCHED_DECODE_FAILED", { exact: false }),
  ).toBeVisible();

  // 也確認讀取真實畸形檔作為輸入不會被改成空檔
  expect(
    readFileSync(fixture("hevc-main10-8bit-malformed-aac.mp4")).length,
  ).toBeGreaterThan(10_000);
});

test("preserves CAPTURE_FAILED instead of misreporting HEVC_PROFILE_MISMATCH when capture fails after auto-fix", async ({
  page,
}) => {
  await installWindowsD3d11Simulator(page, { failCaptureAfterFix: true });
  await page.goto("/?demo=source");

  await page
    .getByLabel("選擇影片")
    .setInputFiles(fixture("hevc-main10-8bit-malformed-aac.mp4"));

  const status = page.getByRole("status");
  await expect(status).toContainText("無法擷取影片影像軌");
  await expect(status).not.toContainText("HEVC 標頭有誤");
  await expect(page.getByTestId("hevc-mismatch-guide")).toHaveCount(0);

  await page.getByText("播放診斷", { exact: true }).click();
  await expect(page.getByText("失敗階段：擷取影音")).toBeVisible();
  await expect(
    page.getByText("自動修正：已套用", { exact: false }),
  ).toBeVisible();
});
