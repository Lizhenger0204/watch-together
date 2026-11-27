/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140：DataChannel 吞吐量測。node docs/decisions/assets/0007/run-dc-bench.mjs "<query>" <收看者數> <秒數>
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const [query = "", viewers = "1", secs = "20"] = process.argv.slice(2);
const port = 8700 + Math.floor(Math.random() * 200);
const srv = spawn(process.execPath, [new URL("./lab-server.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(400);
const b = await chromium.launch({ channel: "chrome", headless: process.env.HEADLESS !== "0", args: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] });
const ctx = await b.newContext();
const url = (r, id) => `http://127.0.0.1:${port}/lab/dc-bench.html?role=${r}&id=${id}&${query}`;
const host = await ctx.newPage();
await host.goto(url("host", "h"));
const vs = [];
for (let i = 0; i < Number(viewers); i++) {
  const p = await ctx.newPage();
  await p.goto(url("viewer", `v${i}`));
  vs.push(p);
}
await sleep(Number(secs) * 1000);
const h = await host.evaluate(() => window.bench.stats);
const per = [];
for (const p of vs) {
  const s = await p.evaluate(() => window.bench.stats);
  const a = s.samples[2], z = s.samples.at(-1);
  // 每 500 ms 的收到速率，找最低的一段（停滯）
  const rates = s.samples.slice(2).map((x, i, arr) => (i ? ((x.received - arr[i - 1].received) * 8) / ((x.t - arr[i - 1].t) / 1000) / 1e6 : null)).filter((x) => x != null);
  per.push({ mbps: +(((z.received - a.received) * 8) / ((z.t - a.t) / 1000) / 1e6).toFixed(1), minWindowMbps: +Math.min(...rates).toFixed(1), zeroWindows: rates.filter((r) => r < 0.5).length });
}
console.log(JSON.stringify({ query, viewers: Number(viewers), per, hostMaxStallMs: Math.round(h.maxStallMs) }));
await b.close();
srv.kill();
