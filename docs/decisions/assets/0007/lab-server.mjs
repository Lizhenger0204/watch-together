/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型用的本機靜態伺服器（支援 Range）。不是正式程式碼。
// 用法：node lab-server.mjs [port] [媒體資料夾...]
//   /lab/<檔名>    → 本資料夾
//   /media/<檔名>  → 依序在媒體資料夾中尋找
//   /vendor/<檔名> → 環境變數 LAB_VENDOR 指定的資料夾（可放 mediabunny.min.mjs，離線用）
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 8140);
const mediaDirs = process.argv.slice(3);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".json": "application/json" };

function resolve(url) {
  const [, area, name] = url.pathname.split("/");
  const file = name ? basename(decodeURIComponent(name)) : "";
  if (!file) return null;
  const dirs = area === "lab" ? [here] : area === "media" ? mediaDirs : area === "vendor" && process.env.LAB_VENDOR ? [process.env.LAB_VENDOR] : [];
  for (const d of dirs) {
    try {
      const p = join(d, file);
      if (statSync(p).isFile()) return p;
    } catch {
      /* 下一個資料夾 */
    }
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = resolve(url);
  if (!path) return res.writeHead(404).end("not found");
  const size = statSync(path).size;
  const headers = { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  createReadStream(path).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`lab server http://127.0.0.1:${port}/lab/`));
