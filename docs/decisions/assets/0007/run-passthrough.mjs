/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型量測：房主分頁 + 兩個收看分頁（同一個 Chrome、loopback DataChannel）。
// 用法（在 repo 根目錄）：
//   node docs/decisions/assets/0007/run-passthrough.mjs <片源路徑> [query 參數，例如 lead=20&high=1048576]
// 需要 Google Chrome（Playwright channel: 'chrome'）。輸出 JSON 到 stdout。
import { execFileSync, spawn } from "node:child_process";
import { dirname, basename } from "node:path";
import { chromium } from "@playwright/test";

const file = process.argv[2];
const extra = process.argv[3] ?? "";
const scenario = process.env.SCENARIO ?? "full";
const port = 8140 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [new URL("./lab-server.mjs", import.meta.url).pathname, String(port), dirname(file)], {
  stdio: "ignore",
  env: { ...process.env },
});
const base = `http://127.0.0.1:${port}/lab/passthrough.html`;
const mb = process.env.LAB_VENDOR ? `&mb=${encodeURIComponent(`http://127.0.0.1:${port}/vendor/mediabunny.min.mjs`)}` : "";
let slot = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(500);

const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.HEADLESS === "1",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ],
});
const ctx = await browser.newContext({ viewport: { width: 700, height: 500 } });

/** Chrome 程序樹（以這次的 user-data-dir 找根程序）的累計 CPU 秒數。 */
function chromeCpuSeconds() {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time=,command="], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      return m && { pid: +m[1], ppid: +m[2], time: m[3], cmd: m[4] };
    })
    .filter(Boolean);
  const root = rows.find((r) => r.cmd.includes("playwright_chromiumdev_profile") && !r.cmd.includes("--type="));
  if (!root) return null;
  const tree = new Set([root.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) (tree.add(r.pid), (grew = true));
  }
  const secs = (t) => t.split(/[:.]/).reduce((acc, v, i, a) => (i === a.length - 1 ? acc + Number(`0.${v}`) : acc * 60 + Number(v)), 0);
  return rows.filter((r) => tree.has(r.pid)).reduce((s, r) => s + secs(r.time), 0);
}
async function cpuOver(ms) {
  const a = chromeCpuSeconds();
  const t = Date.now();
  await sleep(ms);
  const b = chromeCpuSeconds();
  return a == null || b == null ? null : Math.round(((b - a) / ((Date.now() - t) / 1000)) * 100);
}

const host = await ctx.newPage();
await tile(host);
host.on("console", (m) => m.type() === "error" && console.error("[host]", m.text()));
await host.goto(`${base}?role=host&${extra}${mb}`);
await host.setInputFiles("#file", file);
const source = await host.evaluate(() => window.lab.openFile());
await host.evaluate(() => window.lab.play());
const T0 = Date.now();

async function tile(p) {
  const cdp = await ctx.newCDPSession(p);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 20 + slot * 360, top: 40 + slot * 60, width: 700, height: 560 } });
  slot++;
}
async function viewer(name) {
  const p = await ctx.newPage();
  await tile(p);
  p.on("console", (m) => m.type() === "error" && console.error(`[${name}]`, m.text()));
  await p.goto(`${base}?role=viewer&id=${name}&${extra}${mb}`);
  return p;
}
const result = { file: basename(file), source, query: extra, events: [] };

await sleep(3000);
const vA = await viewer("A");
await sleep(5000);
const vB = await viewer("B");
await sleep(4000);
for (const p of [host, vA, vB]) await p.evaluate(() => window.lab.clearFrames());
if (process.env.DIAG) {
  result.diag = [];
  for (let i = 0; i < 6; i++) {
    result.diag.push(await host.evaluate(() => window.lab.diag()));
    await sleep(2000);
  }
}
result.cpuSteady = await cpuOver(20000);
result.steady = await collect("steady");

if (scenario === "full") {
  const dur = await host.evaluate(() => document.querySelector("video").duration);
  const t = await host.evaluate(() => document.querySelector("video").currentTime);
  const fwd = Math.min(dur - 15, t + 25);
  await mark(`seek-forward ${t.toFixed(1)}→${fwd.toFixed(1)}`, () => host.evaluate((x) => window.lab.seek(x), fwd));
  await sleep(10000);
  await mark("seek-back", () => host.evaluate((x) => window.lab.seek(x), Math.max(1, fwd - 15)));
  await sleep(10000);
  await mark("pause", () => host.evaluate(() => window.lab.pause()));
  await sleep(3000);
  await mark("resume", () => host.evaluate(() => window.lab.play()));
  await sleep(8000);
  for (const p of [host, vA, vB]) await p.evaluate(() => window.lab.clearFrames());
  await sleep(10000);
  result.afterEvents = await collect("after-events");
}
result.elapsedS = (Date.now() - T0) / 1000;
console.log(JSON.stringify(result, null, 1));
await browser.close();
server.kill();

async function mark(label, fn) {
  await fn();
  result.events.push({ label, at: Date.now() - T0 });
}

async function collect(label) {
  const [h, a, b] = await Promise.all([host, vA, vB].map((p) => p.evaluate(() => window.lab.metrics())));
  const joins = [a, b].map((v) => ({
    id: v.id,
    dcOpenMs: Math.round(v.t.dcOpen - v.t.hello),
    firstDataMs: Math.round(v.t.firstData - v.t.hello),
    playingMs: Math.round(v.t.playing - v.t.hello),
    syncedMs: v.t.synced ? Math.round(v.t.synced - v.t.hello) : null,
    seekRecoveries: v.syncedAfterEpoch,
    catchUpSeeks: v.seeks,
    holds: v.holds,
    quotaHits: v.quotaHits,
    evictions: v.evictions,
    dropped: v.dropped,
    total: v.total,
    clockRttMs: v.clock && +v.clock.rtt.toFixed(2),
    bufV: v.bufV.map(([s, e]) => [+s.toFixed(1), +e.toFixed(1)]),
    ratesNot1: v.rates.filter((r) => r !== 1).length,
    timeline: process.env.TIMELINE ? v.timeline : undefined,
    dbg: process.env.TIMELINE ? v.dbg : undefined,
    rxMB: +(v.rxBytes / 1e6).toFixed(2),
    rxMsgs: v.rxMsgs,
    queues: v.queues,
    logText: v.logText,
    pcState: v.pcState,
  }));
  return {
    label,
    joins,
    hostLinks: h.links.map((l) => ({ id: l.id, sentMB: +(l.sent / 1e6).toFixed(1), buffered: l.buffered })),
    hostDropped: h.dropped,
    hostLog: h.logText,
    hostSeekWaits: h.events.filter((e) => e.type === "seekWait").map((e) => e.ms),
    hostStartKeys: h.events.filter((e) => e.type === "startKey").map((e) => ({ id: e.id, t: +e.t.toFixed(2), pick: +e.pick.toFixed(2), viaPrev: +e.viaPrev.toFixed(1), viaNext: +e.viaNext.toFixed(1) })),
    hostRestarts: h.events.filter((e) => e.type === "restart").map((e) => [e.id, e.epoch, +e.from.toFixed(2)]),
    syncVsHost: { A: syncError(h.frames, a.frames), B: syncError(h.frames, b.frames) },
    syncAB: syncError(a.frames, b.frames),
  };
}

/** 以參考端的畫面（w=顯示時刻, m=媒體時間）外插，算另一端每張畫面的媒體時間差（毫秒）。 */
function syncError(ref, other) {
  const errs = [];
  let j = 0;
  for (const f of other) {
    while (j + 1 < ref.length && ref[j + 1].w <= f.w) j++;
    const r = ref[j];
    if (!r || r.w > f.w || f.w - r.w > 100) continue;
    errs.push((f.m - (r.m + (f.w - r.w) / 1000)) * 1000);
  }
  if (errs.length === 0) return null;
  const abs = errs.map(Math.abs).sort((x, y) => x - y);
  const mean = errs.reduce((s, x) => s + x, 0) / errs.length;
  const pick = (p) => +abs[Math.min(abs.length - 1, Math.floor(p * abs.length))].toFixed(1);
  return { n: errs.length, meanMs: +mean.toFixed(1), p50: pick(0.5), p95: pick(0.95), max: pick(1) };
}
