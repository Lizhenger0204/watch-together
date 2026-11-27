/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140：node docs/decisions/assets/0007/run-formats.mjs <媒體資料夾> <檔名...>
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const [dir, ...files] = process.argv.slice(2);
const port = 8900 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [new URL("./lab-server.mjs", import.meta.url).pathname, String(port), dir], { stdio: "ignore", env: process.env });
await new Promise((r) => setTimeout(r, 400));
const b = await chromium.launch({ channel: "chrome", headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/lab/passthrough.html?role=none`);
const mb = process.env.LAB_VENDOR ? `http://127.0.0.1:${port}/vendor/mediabunny.min.mjs` : "https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs";
for (const f of files) {
  const r = await p.evaluate(async ([f, mb]) => (await import("/lab/formats.js")).probe(`/media/${f}`, mb).catch((e) => ({ f, error: String(e) })), [f, mb]);
  console.log(JSON.stringify({ file: f, ...r, url: undefined }));
}
await b.close();
srv.kill();
