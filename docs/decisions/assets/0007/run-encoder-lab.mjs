/* eslint-disable -- T-140 實驗原型 */
// node run-encoder-lab.mjs <影片> [高度] [Mbps] [WebCodecs 秒數] [WebRTC 秒數]
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const labUrl = new URL("./encoder-lab.html", import.meta.url).href;
const vendorUrl =
  "https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs";
const [file, height = "1080", mbps = "8", wcs = "30", rtcs = "60"] =
  process.argv.slice(2);
if (!file) throw new Error("請指定本機影片路徑");
const { chromium } = await import(
  process.env.LAB_PLAYWRIGHT
    ? pathToFileURL(process.env.LAB_PLAYWRIGHT).href
    : "@playwright/test"
);
const args = ["--autoplay-policy=no-user-gesture-required"];
if (process.env.LAB_DENY_MEDIA !== "1") {
  args.push(
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  );
}
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args,
});
let nvenc;
try {
  const context = await browser.newContext();
  if (process.env.LAB_MEDIABUNNY) {
    const bundle = await readFile(process.env.LAB_MEDIABUNNY);
    await context.route(vendorUrl, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: bundle,
      }),
    );
  }
  const internals = process.env.LAB_DUMP ? await context.newPage() : null;
  await internals?.goto("chrome://webrtc-internals");
  const page = await context.newPage();
  if (internals) {
    await page.exposeFunction("labRtcDump", async (test) => {
      await internals.evaluate(() => {
        document.querySelector(".peer-connection-dump-root").open = true;
      });
      const [download] = await Promise.all([
        internals.waitForEvent("download", { timeout: 10000 }),
        internals.evaluate(() =>
          document.querySelector("#dump-click-target").click(),
        ),
      ]);
      const path = process.env.LAB_DUMP.replace(
        /(?:\.gz)?$/,
        "-" + test + ".gz",
      );
      await download.saveAs(path);
    });
  }
  await page.bringToFront();
  page.on(
    "console",
    (item) => item.type() === "error" && console.error("[頁面]", item.text()),
  );
  page.on("pageerror", (error) => console.error("[頁面]", error.message));
  const session = await context.newCDPSession(page);
  const browserSession = await browser.newBrowserCDPSession();
  const players = new Map();
  session.on("Media.playerPropertiesChanged", ({ playerId, properties }) => {
    const state = players.get(playerId) ?? {};
    for (const { name, value } of properties) state[name] = value;
    players.set(playerId, state);
  });
  await session.send("Media.enable");
  let evidence;
  await page.exposeFunction("labEncoderEvidence", async (phase) => {
    if (phase === "begin") {
      const trial = { initialPlayers: new Set(players.keys()), nvencText: "" };
      evidence = trial;
      if (process.platform === "win32") {
        nvenc = spawn("nvidia-smi", ["encodersessions", "-l", "1"], {
          windowsHide: true,
        });
        nvenc.on("error", () => {});
        nvenc.stdout.on("data", (bytes) => {
          trial.nvencText += bytes.toString();
        });
      }
      return;
    }
    const { processInfo } = await browserSession.send(
      "SystemInfo.getProcessInfo",
    );
    nvenc?.kill();
    nvenc = undefined;
    const chromePids = new Set(processInfo.map(({ id }) => id));
    const matches = [
      ...evidence.nvencText.matchAll(
        /^\s*\d+\s+\d+\s+(\d+)\s+(H\.264)\s+(\d+)\s+(\d+)\s+(\d+)/gm,
      ),
    ].filter((match) => chromePids.has(Number(match[1])));
    const maxFps = Math.max(0, ...matches.map((match) => Number(match[5])));
    const media = [...players].filter(
      ([id, state]) =>
        !evidence.initialPlayers.has(id) && state.kVideoEncoderName,
    );
    const info = media.at(-1)?.[1];
    return {
      implementation:
        info?.kVideoEncoderName ??
        (matches.length ? "NVIDIA NVENC（驅動工作階段）" : null),
      hardwareAccelerated:
        info?.kIsPlatformVideoEncoder == null
          ? matches.length
            ? true
            : null
          : String(info.kIsPlatformVideoEncoder) === "true",
      ...(matches.length
        ? { nvenc: { sampleCount: matches.length, maxFps } }
        : {}),
    };
  });
  if (process.env.LAB_DENY_MEDIA === "1") {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("測試拒絕權限", "NotAllowedError"));
    });
  }
  await page.goto(labUrl);
  await page.setInputFiles("#file", file);
  await page.selectOption("#height", height);
  await page.selectOption("#br", mbps);
  await page.fill("#wcs", wcs);
  await page.fill("#rtcs", rtcs);
  await page.click("#run");
  let last = "";
  const poll = setInterval(async () => {
    const status = await page
      .locator("#status")
      .textContent()
      .catch(() => "");
    if (status && status !== last) {
      console.error(status.slice(last.length).trim());
      last = status;
    }
  }, 2000);
  let out;
  try {
    await page.waitForFunction(() => window.labDone, null, {
      timeout: 15 * 60 * 1000,
    });
    out = await page.evaluate(() => window.labDone);
  } finally {
    clearInterval(poll);
  }
  if (process.env.LAB_SCREENSHOT) {
    await page.screenshot({ path: process.env.LAB_SCREENSHOT, fullPage: true });
  }
  console.log(JSON.stringify(out));
  if (out.error) process.exitCode = 1;
} finally {
  nvenc?.kill();
  await browser.close();
}
