# 任務看板

## 規則

- 狀態：`TODO` → `DOING` → `REVIEW` → `DONE`（或 `BLOCKED`）。
- **本檔只在 `main` 上由協調者（使用者或 Claude 主對話）修改**。agent 在自己的分支／worktree 裡不要改本檔，避免合併衝突。
- 派工：協調者把任務改為 `DOING` 並 commit 到 `main`，再開 worktree 交給 agent。
- 完成：agent 把交接備註（下面四項）寫在分支最後一個 commit 的訊息內文。協調者合併時把它貼到本檔「交接備註」，狀態改 `REVIEW`；review 通過後改 `DONE`。
  1. 做了什麼（含主要檔案）
  2. 對外介面／訊息有無變動
  3. 已知限制、TODO
  4. 如何驗證（指令或步驟）
- agent 發現需要新任務（缺 spec、需要對方改動）：寫在 commit 訊息或回報給協調者，由協調者新增到看板。
- 新任務編號遞增，不重用。T-001～T-012 屬於已廢棄的 ADR 0001 架構，不再使用。

## 看板（ADR 0002）

| 編號 | 任務 | 負責 | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| T-101 | Scaffold：pnpm workspace、apps/web（Vite + React + TS + Tailwind）、apps/signal（Hono + wrangler + DO 骨架）、packages/shared、ESLint / Prettier / Vitest、`pnpm dev` 與 proxy | GPT | — | DONE |
| T-102 | `packages/shared`：依 protocol.md 寫 zod schema、訊息型別、常數 | Claude | T-101 | DONE |
| T-103 | 房間核心 + REST（建房 / 加入 / 重產邀請碼）+ RoomDO / InviteDirectoryDO + WebSocket 驗證 + 信令轉送 + 生命週期 + 限流 | Claude | T-102 | DOING |
| T-104 | `/api/ice`：STUN 清單 + Cloudflare TURN 短效憑證（沒有 secrets 時只回 STUN） | GPT | T-102 | DONE |
| T-105 | 前端頁面：首頁（建房 / 輸入邀請碼）、`/join/:code`、房間頁（房主版 / 收看者版）、成員列表與連線品質、模式與畫質選項卡、複製邀請碼 | Claude | T-102 | TODO |
| T-106 | 選片：檔案選擇、開播前檢查、本地播放與自訂控制列、captureStream、房主音量實測並更新 streaming.md | GPT | T-101 | DOING |
| T-107 | P2P 傳輸：房主 mesh、收看者連線、codec 偏好、畫質與縮放、ICE restart、統計 | Claude | T-103, T-104 | TODO |
| T-108 | 轉發轉接：WHIP / WHEP → Cloudflare Realtime（參考官方範例，先確認授權） | GPT | T-103 | TODO |
| T-109 | 轉發傳輸客戶端（WHIP / WHEP）+ 模式切換流程 | Claude | T-107, T-108 | TODO |
| T-110 | 收看端播放器：srcObject、點擊開始觀看、狀態提示、重新連線按鈕 | Claude | T-107 | TODO |
| T-111 | E2E：3 個 context 的 P2P 流程 | GPT | T-105, T-106, T-110 | TODO |
| T-112 | 部署：給零經驗使用者的 Cloudflare 帳號與網域設定圖文指南、`pnpm deploy`、secrets 設定、CI | GPT | T-103 | TODO |
| T-113 | 人工驗收清單（ADR 0002 待驗證項目），做完後交給使用者與朋友實測 | Claude | T-109, T-111, T-112 | TODO |

可平行的組合：T-101 完成後 → T-102（Claude）∥ T-106（GPT）；T-102 完成後 → T-103、T-105（Claude，依序）∥ T-104（GPT）；T-103 完成後 → T-108、T-112（GPT）。

## 交接備註

<!-- 格式：
### T-10X（agent，日期）
1. 做了什麼：
2. 介面變動：
3. 已知限制：
4. 驗證方式：
-->

### T-101（GPT，2026-11-24）— DONE
1. 做了什麼：pnpm workspace（apps/web、apps/signal、packages/shared、e2e）、TS / ESLint / Prettier、`scripts/dev.mjs`、Vite + React 19 + Tailwind 4 首頁、Hono Worker 與兩個空的 SQLite Durable Object、Workers Vitest、Playwright smoke test。
2. 介面變動：實作 `GET /api/health` → `{ ok: true, protocolVersion: 1 }`；Vite proxy 轉發 `/api` 與 WebSocket；port 由 `WEB_PORT` / `SIGNAL_PORT` 設定。
3. 已知限制：房間與 WebSocket 路由待 T-103，部署待 T-112。
4. 驗證方式：`pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e`。

Review（Claude，commit 7f5b1eb）：改用更名後的 `@cloudflare/vitest-plugin`（舊名已停止維護）；移除 `minimumReleaseAgeExclude`，改選已過 pnpm 冷卻期的版本；`compatibility_date` 改為 2026-11-15；重新產生 lockfile。全部檢查重新跑過並通過。

### T-104（GPT，2026-11-24）— DONE
1. 做了什麼：`apps/signal/src/ice/`：`getIceServers`（Cloudflare + 小米 STUN、Cloudflare TURN 4 小時憑證、5 秒逾時、失敗退回只回 STUN）與 `createIceRoutes({ requireMember })`。
2. 介面變動：無；TURN API 為 `POST https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers`（[官方文件](https://developers.cloudflare.com/realtime/turn/generate-credentials/)）。
3. 已知限制：小米 STUN 在中國大陸的可用性待 T-113 實測；路由待 T-103 掛載。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test`。

Review（Claude）：TURN 回傳的 port 53 位址會被瀏覽器擋下，由 T-103 一併過濾。
