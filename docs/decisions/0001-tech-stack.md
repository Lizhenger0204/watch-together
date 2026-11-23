# ADR 0001：技術選型

- 狀態：部分被 [ADR 0002](0002-browser-live-streaming.md) 取代（影片傳遞、後端、上傳、轉檔部分）
- 日期：2026-11-24

## 決定

| 層 | 選擇 | 理由 |
| --- | --- | --- |
| 語言 | TypeScript（strict），Node.js 22 LTS | 前後端共用型別 |
| 套件管理 | pnpm workspace | monorepo、`packages/shared` 共用 |
| 前端 | Vite + React 19 | 生態成熟，兩個 agent 都熟（T-101 起用 19） |
| 樣式 | Tailwind CSS | 不需要另寫 CSS 規範 |
| 播放 | hls.js（Safari 用原生 HLS） | 統一播放路徑，見下方 |
| 後端 HTTP | Fastify | 效能好、schema 友善 |
| 即時通訊 | Socket.IO | 內建房間、自動重連、ack |
| 上傳 | tus（`@tus/server` + `tus-js-client`） | 數 GB 影片可續傳 |
| 轉檔 | ffmpeg / ffprobe（系統安裝） | 業界標準 |
| 驗證 | zod | schema 同時給前後端與型別推導 |
| 測試 | Vitest、Playwright | 單元 + 多瀏覽器 E2E |

## 為什麼統一轉成 HLS

使用者會上傳各種格式（mkv、HEVC、AC3 音軌），瀏覽器支援度不一。統一輸出 H.264/AAC 的 HLS：

- 前端只需一條播放路徑，同步邏輯不用處理格式差異。
- 編碼相容時用 `-c copy` 只重新封裝，幾乎不耗 CPU。
- 分段傳輸讓 seek 時不必下載整個檔案。

代價：上傳完要等處理完成才能播放。可接受。

## 為什麼不用 WebRTC P2P

房主家用網路上行頻寬通常不足以同時推給多人、NAT 穿透需要 TURN 伺服器、房主關掉分頁就斷。伺服器中轉最簡單可靠。
