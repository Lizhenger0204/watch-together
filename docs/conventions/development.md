# 開發環境

## 需求

- Node.js 22 LTS、pnpm（已透過 Homebrew + corepack 安裝）。
- Cloudflare 帳號：**本機開發 P2P 模式不需要**；轉發模式、TURN、部署才需要（見下方 secrets）。
- 不需要 ffmpeg（ADR 0002 起不在伺服器轉碼）。
- 目前專案尚未 scaffold；T-101 完成後以下指令才可用。

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
| `pnpm deploy` | 部署 signal 與 web 到 Cloudflare（T-112 建立） |

這些 script 名稱是契約，scaffold 時必須提供，之後不可隨意改名。

## 設定

### 一般變數（`apps/signal/wrangler.toml` 的 `[vars]`）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | CORS 與邀請連結 |
| `ROOM_MAX_MEMBERS` | `8` | 含房主 |
| `ROOM_IDLE_TTL_MS` | `1800000` | 無人後 30 分鐘關房 |
| `ROOM_MAX_AGE_MS` | `86400000` | 24 小時 |

### Secrets（`wrangler secret put`；本機放 `apps/signal/.dev.vars`，已被 gitignore）

| 名稱 | 用途 |
| --- | --- |
| `REALTIME_APP_ID` / `REALTIME_APP_TOKEN` | Cloudflare Realtime SFU（轉發模式） |
| `TURN_KEY_ID` / `TURN_KEY_TOKEN` | Cloudflare TURN 短效憑證 |

沒有設定時：`/api/ice` 只回 STUN；WHIP / WHEP 回 `503 RELAY_UNAVAILABLE`，前端停用「轉發」選項卡並顯示原因。

新增變數時同步更新本表與 `apps/signal/.dev.vars.example`。

### 前端（`apps/web/.env`）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `WEB_PORT` | `5173` | Vite dev server |
| `SIGNAL_PORT` | `8787` | Vite proxy 目標 |

## 本機測試 P2P

- 同一台電腦開兩個瀏覽器視窗即可（一個房主、一個收看者）。
- 用手機測試時，手機和電腦要在同一個網路，並用電腦的區網 IP 開啟（Vite 需 `--host`）。注意：非 `localhost` 的 HTTP 頁面不能用某些 API（剪貼簿），WebRTC 在部分瀏覽器也要求 HTTPS；必要時用 `wrangler` 部署到預覽環境測試。
