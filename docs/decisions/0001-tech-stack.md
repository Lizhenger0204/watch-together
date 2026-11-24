# ADR 0001：技術選型

- 狀態：**已被 [ADR 0002](0002-browser-live-streaming.md) 取代**
- 日期：2026-11-24

最初的方案是「上傳到伺服器 → ffmpeg 轉 HLS → 分發」（Fastify、Socket.IO、tus、hls.js）。這些都已作廢，不要照著實作。
仍沿用的選擇（TypeScript、pnpm workspace、Vite + React、zod、Vitest、Playwright）已列在 ADR 0002「技術選擇」。
完整原文見 git 歷史。
