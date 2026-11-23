# 開發環境

## 需求

- Node.js 22 LTS、pnpm（已透過 Homebrew + corepack 安裝）。
- Cloudflare 帳號：**本機開發 P2P 模式不需要**；轉發模式、TURN、部署才需要（見下方 secrets）。
- 不需要 ffmpeg（ADR 0002 起不在伺服器轉碼）。
- 跑 `pnpm e2e` 需要 Playwright Chromium（`pnpm exec playwright install chromium`）與本機安裝的 Google Chrome（播放真實影片的測試用 `channel: 'chrome'`）。

## 指令（根目錄）

| 指令 | 作用 |
| --- | --- |
| `pnpm install` | 安裝依賴 |
| `pnpm dev` | 同時啟動 web（Vite，`WEB_PORT`，預設 5173）與 signal（`wrangler dev`，`SIGNAL_PORT`，預設 8787）；Vite proxy 轉發 `/api`（含 WebSocket） |
| `pnpm build` | 建置全部 |
| `pnpm typecheck` | `tsc --noEmit`（全 workspace） |
| `pnpm lint` | ESLint + Prettier 檢查 |
| `pnpm test` | Vitest（全 workspace） |
| `pnpm e2e` | Playwright |
| `pnpm deploy` | 建置 web，再以 `--env production` 部署 signal Worker（前端靜態檔一併上傳，見下方「部署」） |

這些 script 名稱是契約，之後不可隨意改名。

## 部署

一步步的操作見 [docs/guides/deploy.md](../guides/deploy.md)，這裡只記規則與坑。

- **一律用 `--env production`**。Worker 名稱為 `remote-sync-player-signal-production`；頂層設定只給 `wrangler dev` 與 Vitest 用。
- **同源部署**：前端靜態檔（`apps/web/dist`）由同一個 Worker 的 static assets 提供，`/api/*` 一定先進 Worker（`run_worker_first`），其餘路徑交給 SPA。網頁、REST、WebSocket 同一個網址，**不需要 CORS**。
- **`[env.production]` 不繼承頂層的 vars、Durable Object bindings、Rate Limiting bindings**，新增時兩邊都要寫。
- **`pnpm deploy` 加旗標會變成 pnpm 內建的 `deploy` 指令**。不加旗標時才會執行專案 script；要明確執行專案 script 用 `pnpm run deploy`。預演（不真的上傳）用：

  ```sh
  pnpm --filter @project/web build && pnpm --filter @project/signal exec wrangler deploy --env production --dry-run
  ```

## CI

`.github/workflows/ci.yml` 在 push 與 PR 時依序跑 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm e2e`。e2e 前會執行 `playwright install --with-deps chromium chrome`：Playwright Chromium 跑一般頁面測試，Google Chrome 給選片（source）測試用（`channel: 'chrome'`，內建 Chromium 不支援 H.264／AAC）。失敗時上傳 Playwright 報告。

## 設定

### 一般變數（`apps/signal/wrangler.toml`：本機用 `[vars]`，正式環境用 `[env.production.vars]`）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | 本機 `http://localhost:5173`；正式環境 `https://watch.example.com`（**部署前改成真網址**） | 正式網址。與 CORS 無關（同源部署不需要 CORS）。目前沒有程式讀取：邀請連結由前端以 `location.origin` 組成（`apps/web/src/lib/router.ts`），同源部署下就是正式網址 |
| `ROOM_MAX_MEMBERS` | `8` | 含房主 |
| `ROOM_IDLE_TTL_MS` | `1800000` | 無人後 30 分鐘關房 |
| `ROOM_MAX_AGE_MS` | `86400000` | 24 小時 |

### Secrets（`wrangler secret put`；本機放 `apps/signal/.dev.vars`，已被 gitignore）

| 名稱 | 用途 |
| --- | --- |
| `REALTIME_APP_ID` / `REALTIME_APP_TOKEN` | Cloudflare Realtime SFU（轉發模式） |
| `TURN_KEY_ID` / `TURN_KEY_TOKEN` | Cloudflare TURN 短效憑證 |

沒有設定時：`/api/rooms/:roomId/ice` 只回 STUN；WHIP / WHEP 回 `503 RELAY_UNAVAILABLE`，前端停用「轉發」選項卡並顯示原因。

新增變數時同步更新本表與 `apps/signal/.dev.vars.example`。

### 前端（`apps/web/.env`）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `WEB_PORT` | `5173` | Vite dev server |
| `SIGNAL_PORT` | `8787` | Vite proxy 目標 |

## 本機測試 P2P

- 同一台電腦開兩個瀏覽器視窗即可（一個房主、一個收看者）。
- 用手機測試時，手機和電腦要在同一個網路，並用電腦的區網 IP 開啟（Vite 需 `--host`）。注意：非 `localhost` 的 HTTP 頁面不能用某些 API（剪貼簿），WebRTC 在部分瀏覽器也要求 HTTPS；必要時用 `wrangler` 部署到預覽環境測試。
