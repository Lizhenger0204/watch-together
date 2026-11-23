# 任務看板

## 規則

- 狀態：`TODO` → `DOING` → `REVIEW` → `DONE`（或 `BLOCKED`）。
- **本檔只在 `main` 上由協調者（「GPT 監工」Claude 對話，見 ownership.md）修改**。agent 在自己的分支／worktree 裡不要改本檔，避免合併衝突。
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
| T-103 | 房間核心 + REST（建房 / 加入 / 重產邀請碼）+ RoomDO / InviteDirectoryDO + WebSocket 驗證 + 信令轉送 + 生命週期 + 限流 | Claude | T-102 | DONE |
| T-104 | `/api/ice`：STUN 清單 + Cloudflare TURN 短效憑證（沒有 secrets 時只回 STUN） | GPT | T-102 | DONE |
| T-105 | 前端頁面：首頁（建房 / 輸入邀請碼）、`/join/:code`、房間頁（房主版 / 收看者版）、成員列表與連線品質、模式與畫質選項卡、複製邀請碼 | Claude | T-102 | TODO |
| T-106 | 選片：檔案選擇、開播前檢查、本地播放與自訂控制列、captureStream、房主音量實測並更新 streaming.md | GPT | T-101 | DONE |
| T-107 | P2P 傳輸：房主 mesh、收看者連線、codec 偏好、畫質與縮放、ICE restart、統計 | Claude | T-103, T-104, T-114 | TODO |
| T-108 | 轉發轉接：WHIP / WHEP → Cloudflare Realtime（參考官方範例，先確認授權） | GPT | T-103 | DOING |
| T-109 | 轉發傳輸客戶端（WHIP / WHEP）+ 模式切換流程 | Claude | T-107, T-108 | TODO |
| T-110 | 收看端播放器：srcObject、點擊開始觀看、狀態提示、重新連線按鈕 | Claude | T-107 | TODO |
| T-111 | E2E：3 個 context 的 P2P 流程 | GPT | T-105, T-106, T-110 | TODO |
| T-112 | 部署：給零經驗使用者的 Cloudflare 帳號與網域設定圖文指南、`pnpm deploy`、secrets 設定、CI | GPT | T-103 | DOING |
| T-113 | 人工驗收清單（ADR 0002 待驗證項目），做完後交給使用者與朋友實測 | Claude | T-109, T-111, T-112 | TODO |
| T-114 | T-103 審查修正：邀請碼重產與關房序列化、關房清理可重試、限流後備、token 常數時間比對；spec 補房主接手（4000）時的 `peer:request` 順序、未驗證連線格式錯誤以 4400 關閉、ICE 新路徑同步 shared 與版本說明 | Claude | T-103 | TODO |

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

### T-106（GPT，2026-11-24）— DONE
1. 做了什麼：`features/source/`：選檔、開播前檢查（TIMEOUT / VIDEO_UNDECODABLE / NO_AUDIO / CAPTURE_UNSUPPORTED）、無音軌確認、`HostSourcePlayer` 自訂控制列、每片一次 `captureStream()`、`computeScaleDownBy`。E2E 測試影片在 `e2e/fixtures/`。
2. 介面變動：匯出 `useLocalSource(onStreamChange?)`（回傳 `videoRef`、`title`、`stream`、`check`、`selectFile`、`continueWithoutAudio`）、`HostSourcePlayer`、`computeScaleDownBy`。
3. 已知限制：`App.tsx` 的 `?demo=source` 是暫時入口，T-105 由 Claude 移除並搬移 E2E 入口。CI 需安裝 Playwright Chromium（health）與 Google Chrome（source）。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`。

實測結論（已寫入 streaming.md §1）：Chrome 的房主音量不影響擷取音訊；影片播完時擷取 track 會被移除；HEVC + AAC 測試片在本機 Chrome 可解碼。

### T-103（Claude，2026-11-24）— DONE
1. 做了什麼：`room/room.ts`（房間狀態純邏輯）、`signaling/process.ts`（auth／訊息／斷線純邏輯與信令轉送規則）、`app.ts`（`createApp`、建房／加入（限流）／重產邀請碼／WebSocket、掛載 ICE、`requireMember`／`requireHost`）、`runtime/workers`（RoomDO 用 WebSocket Hibernation 與 alarm、InviteDirectoryDO、`JOIN_RATE_LIMITER`）、ICE 過濾 port 53。
2. 介面變動：ICE 路徑改為 `GET /api/rooms/:roomId/ice`；新增 WebSocket 關閉碼表（protocol.md）；房主斷線時直播改為未開播；離線超過 10 分鐘的收看者在有人加入時被移除（room-and-invite.md）。
3. 已知限制：沒有 `JOIN_RATE_LIMITER` 綁定時不限流；`runtime/node` 尚未實作。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`。

Review（GPT，監工核對）：結論「小修後可合併」，沒有安全漏洞（token 只存雜湊、收看者 signal 只能送房主、伺服器端角色檢查、踢人後 token 失效皆符合）。合併到 main 時 typecheck／lint／test 121／e2e 3 全過。待修項目開為 T-114，需在 T-107 前完成：並發重產邀請碼會讓其中一個回傳碼失效並留下孤兒對照；關房清理 RPC 失敗後 alarm 重試會跳過；直播中房主被同一成員新連線取代時不會重發 `peer:request`；未驗證連線的首幀格式錯誤未斷線、五秒期限在雜湊前判斷；缺限流綁定時放行；token 比對非常數時間；shared 的 ICE 路由註解仍是舊路徑。測試缺口：休眠喚醒還原、alarm 共用、混合 port 53 的 TURN 過濾斷言。
