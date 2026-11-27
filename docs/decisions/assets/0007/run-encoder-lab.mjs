/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140：在本機用 Playwright 跑 encoder-lab.html（與 Windows 使用者開的是同一頁）。
// node docs/decisions/assets/0007/run-encoder-lab.mjs <影片> [高度] [Mbps] [WebCodecs 秒數] [WebRTC 秒數]
import { chromium } from "@playwright/test";

const [file, height = "1080", mbps = "8", wcs = "30", rtcs = "60"] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chrome", headless: false, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage();
p.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
await p.goto(new URL("./encoder-lab.html", import.meta.url).href);
await p.setInputFiles("#file", file);
await p.selectOption("#height", height);
await p.selectOption("#br", mbps);
await p.fill("#wcs", wcs);
await p.fill("#rtcs", rtcs);
await p.click("#run");
let last = "";
const poll = setInterval(() => p.evaluate(() => document.querySelector("#status").textContent).then((t) => (last = t)).catch(() => {}), 2000);
await p.waitForFunction(() => window.labDone, null, { timeout: 0 }).catch((e) => {
  console.error(`頁面中斷：${e.message}\n最後狀態：\n${last}`);
  process.exit(1);
});
clearInterval(poll);
console.log(JSON.stringify(await p.evaluate(() => window.labDone)));
await b.close();
