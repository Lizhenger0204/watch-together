/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 種子式散布原型量測：房主＋N 位收看者（同一個 Chrome、loopback DataChannel）。
// 用法（repo 根目錄）：node docs/decisions/assets/0007/run-swarm.mjs <片源> [人數=3] [房主 query] [收看者 query]
// 環境變數：EVIL=<收看者代號>（該收看者轉送時竄改資料）、NOUP=<代號,...>（不上傳）、
//   LEAVE=1（量完穩態後最後一位離開、新的一位加入）、HEADLESS=1。輸出 JSON 到 stdout。
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { chromium } from "@playwright/test";

const [file, nArg = "3", hostQ = "", viewerQ = ""] = process.argv.slice(2);
const N = Number(nArg);
const port = 8640 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, [new URL("./lab-server.mjs", import.meta.url).pathname, String(port), dirname(file)], { stdio: "ignore" });
const base = `http://127.0.0.1:${port}/lab/swarm.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(500);
const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.HEADLESS === "1",
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
const ctx = await browser.newContext({ viewport: { width: 340, height: 300 } });
let slot = 0;
async function page(q, name) {
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 10 + (slot % 4) * 350, top: 30 + Math.floor(slot / 4) * 380, width: 350, height: 380 } });
  slot++;
  p.on("console", (msg) => msg.type() === "error" && console.error(`[${name}]`, msg.text()));
  p.on("pageerror", (e) => console.error(`[${name}]`, e.message));
  await p.goto(`${base}?${q}`);
  await p.waitForFunction(() => window.lab);
  return p;
}
const evil = process.env.EVIL ?? "";
const noUp = (process.env.NOUP ?? "").split(",");
const host = await page(`role=host&${hostQ}`, "host");
const source = await host.evaluate((u) => window.lab.open(u), `/media/${encodeURIComponent(basename(file))}`);
await host.evaluate(() => window.lab.play());
const T0 = Date.now();
const viewers = [];
const names = "ABCDEFGH".split("");
for (let k = 0; k < N; k++) {
  await sleep(2000);
  const id = names[k];
  viewers.push(await page(`role=viewer&id=${id}${id === evil ? "&evil=1" : ""}${noUp.includes(id) ? "&upload=0" : ""}&${viewerQ}`, id));
}
const result = { file: basename(file), source, n: N, hostQ, viewerQ, evil, noUp: process.env.NOUP ?? "", phases: {} };

async function phase(label, ms) {
  const h0 = await host.evaluate(() => window.lab.metrics());
  const v0 = await Promise.all(viewers.map((p) => p.evaluate(() => window.lab.metrics())));
  const since = Date.now() + 0;
  const t0 = await host.evaluate(() => performance.timeOrigin + performance.now());
  await sleep(ms);
  const h1 = await host.evaluate(() => window.lab.metrics());
  const v1 = await Promise.all(viewers.map((p) => p.evaluate((s) => window.lab.metrics(s), t0)));
  const secs = ms / 1000;
  const mbps = (a, b) => +(((b - a) * 8) / secs / 1e6).toFixed(1);
  const hostSent = (x) => x.sent.seed + x.sent.repair + x.sent.join;
  result.phases[label] = {
    seconds: secs,
    hostMbps: mbps(hostSent(h0), hostSent(h1)),
    hostSeedMbps: mbps(h0.sent.seed, h1.sent.seed),
    hostRepairMbps: mbps(h0.sent.repair, h1.sent.repair),
    hostJoinMbps: mbps(h0.sent.join, h1.sent.join),
    viewers: v1.map((v, k) => {
      const a = v0.find((x) => x.id === v.id) ?? { fromHost: 0, fromPeers: 0, uploaded: 0, hashFail: 0, repairs: 0, waiting: 0 };
      return { id: v.id, upload: v.upload, fromHostMbps: mbps(a.fromHost, v.fromHost), fromPeersMbps: mbps(a.fromPeers, v.fromPeers), uploadMbps: mbps(a.uploaded, v.uploaded), hashFail: v.hashFail - a.hashFail, repairs: v.repairs - a.repairs, waiting: v.waiting - a.waiting, driftP50: v.p50, driftP95: v.p95, driftN: v.driftN, startMs: v.startMs, seekRecover: v.seekRecover, hostSeekRecover: v.hostSeekRecover, badPeers: v.badPeers, dropped: v.dropped };
    }),
    events: h1.events.slice(h0.events.length),
  };
  void since;
}

await sleep(Number(process.env.SETTLE ?? 12000));
await phase("steady", 20000);
const t = await host.evaluate(() => window.lab.time());
await host.evaluate((x) => window.lab.seek(x), Math.min(source.duration - 30, t + 20));
await phase("afterSeek", 12000);
if (process.env.LEAVE === "1") {
  const gone = viewers.pop();
  await gone.close();
  await sleep(1000);
  const id = names[N];
  viewers.push(await page(`role=viewer&id=${id}&${viewerQ}`, id));
  await phase("leaveJoin", 12000);
}
if (process.env.DUMP) result.dump = await Promise.all(viewers.map((p) => p.evaluate(() => { const v = document.querySelector("video"); return { log: document.querySelector("#log").textContent.slice(-1500), t: v.currentTime, paused: v.paused, rs: v.readyState, buf: [...Array(v.buffered.length).keys()].map((k) => [v.buffered.start(k), v.buffered.end(k)]), E: window.lab.expected(), stored: window.lab.metrics().stored, debug: window.lab.debug() }; })));
if (process.env.DUMP) result.hostLinks = (await host.evaluate(() => window.lab.metrics())).links;
result.totals = await Promise.all(viewers.map((p) => p.evaluate(() => { const x = window.lab.metrics(); return { id: x.id, hashFail: x.hashFail, repairs: x.repairs, badPeers: x.badPeers, fromHostMB: +(x.fromHost / 1e6).toFixed(1), fromPeersMB: +(x.fromPeers / 1e6).toFixed(1), uploadedMB: +(x.uploaded / 1e6).toFixed(1), dupMB: +(x.dupBytes / 1e6).toFixed(1) }; })));
result.sha256Ms4MiB = await host.evaluate(async () => { const b = crypto.getRandomValues(new Uint8Array(65536)); const big = new Uint8Array(4 << 20); for (let o = 0; o < big.length; o += 65536) big.set(b, o); const t = performance.now(); for (let k = 0; k < 10; k++) await crypto.subtle.digest("SHA-256", big); return +((performance.now() - t) / 10).toFixed(2); });
result.hostPerSec = (await host.evaluate(() => window.lab.metrics())).perSec;
result.elapsedS = (Date.now() - T0) / 1000;
console.log(JSON.stringify(result, null, 1));
await browser.close();
server.kill();
