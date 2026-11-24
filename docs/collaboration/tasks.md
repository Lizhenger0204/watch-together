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
| T-105 | 前端頁面：首頁（建房 / 輸入邀請碼）、`/join/:code`、房間頁（房主版 / 收看者版）、成員列表與連線品質、模式與畫質選項卡、複製邀請碼 | Claude | T-102 | DONE |
| T-106 | 選片：檔案選擇、開播前檢查、本地播放與自訂控制列、captureStream、房主音量實測並更新 streaming.md | GPT | T-101 | DONE |
| T-107 | P2P 傳輸（`features/transport/p2p/`，照 T-115 的介面）：房主 mesh、收看者連線、codec 偏好、畫質與縮放、ICE restart、統計 | GPT | T-103, T-104, T-114, T-115 | DONE |
| T-108 | 轉發轉接：WHIP / WHEP → Cloudflare Realtime（參考官方範例，先確認授權） | GPT | T-103 | DONE |
| T-109 | 轉發傳輸客戶端（`features/transport/relay/`，WHIP / WHEP，照 T-115 的介面），並回答 T-108 留下的 (a)～(c) | Claude | T-108, T-114, T-115 | TODO |
| T-110 | 收看端播放器：原生 `<video srcObject>`（沿用 T-106 的元件）、點擊開始觀看、狀態提示、重新連線按鈕 | Claude | T-105, T-115 | REVIEW |
| T-111 | E2E：3 個 context 的 P2P 流程 | GPT | T-105, T-106, T-107, T-110, T-118 | TODO |
| T-112 | 部署：給零經驗使用者的 Cloudflare 帳號與網域設定圖文指南、`pnpm deploy`、secrets 設定、CI | GPT | T-103 | DONE |
| T-113 | 人工驗收清單（ADR 0002 待驗證項目），做完後交給使用者與朋友實測 | Claude | T-109, T-111, T-112 | TODO |
| T-114 | T-103 審查修正：邀請碼重產與關房序列化、關房清理可重試、限流後備、token 常數時間比對；spec 補房主接手（4000）時的 `peer:request` 順序、未驗證連線格式錯誤以 4400 關閉、ICE 新路徑同步 shared 與版本說明；關房時呼叫 `RoomDO.closeRelayResources()`（失敗保留記錄重試） | Claude | T-103, T-108 | DONE |
| T-115 | 傳輸層共用架構：`createHostTransport` / `createViewerTransport` 介面、`features/transport/common/`（編碼與畫質、ICE 設定取得、狀態事件、統計共用部分）、模式切換流程，寫進 streaming.md；給 T-107（GPT）與 T-109 共用 | Claude | T-102 | DONE |
| T-116 | T-114 第二輪審查的後續修正：邀請目錄換碼改為單一交易（不留孤兒對照）；relay 清理待辦、重試狀態與 alarm 一起提交；SFU 回 `410 session_error` 時視為已結束、不重試；可考慮 WebSocket upgrade 每 IP 限流；protocol.md 4408 改為「5 秒內未完成驗證」；room-and-invite.md「前端以最後收到的回應為準」改為前端序列化重產或以 snapshot 校正；**T-117 審查：有效成員多佔一席**（已知邀請對照遇到 `GET /ice` 暫時失敗時改走 `POST /join`；房主換碼後既有成員點新碼會再配一席，房間已鎖或已滿時回 404／409），需要先改 spec 與 shared，讓持原房憑證的人在配置席位前比對邀請碼、沿用既有成員 | Claude | T-114 | TODO |
| T-117 | T-105 第二輪審查遺留修正（T-105 未修完即合併）：**收看者第一次加入時要記住邀請碼與房間的對照**（現在每點一次邀請連結都會 `POST /join`，伺服器累積離線成員，10 分鐘內可能 `ROOM_FULL`，屬阻擋級）；長片名在 390px 撐寬版面；開播失敗後手動重試沒有送出請求 | Claude | T-105 | DONE |
| T-118 | 房主端接上傳輸層（房間層）：開播時建立傳輸並開始送畫面、換片時更新 track（replaceTrack）、踢人或收看者離線時 `removePeer`、直播中切模式（streaming.md §6「先停再開」）、開播前 60 Mbps 總上傳量提示；依 mode 分派 p2p／relay 的 dispatcher（relay 部分等 T-109） | Claude | T-107, T-110, T-115 | DOING |

可平行的組合：T-101 完成後 → T-102（Claude）∥ T-106（GPT）；T-102 完成後 → T-103、T-105（Claude，依序）∥ T-104（GPT）；T-103 完成後 → T-108、T-112（GPT）。T-115（Claude）可與 T-105／T-114 的審查同時進行；T-114 與 T-115 都合併後 → T-107（GPT）∥ T-109、T-110（Claude）。

> 2026-11-24 使用者決定：T-107 改由 GPT 負責，前提是 Claude 先完成傳輸層共用架構（T-115）。T-110 沿用原生 `<video srcObject>` 與 T-106 的元件。

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

### T-108（GPT，2026-11-24）— DONE
1. 做了什麼：`relay/sdp.ts`（SDP offer 檢查）、`relay/realtime.ts`（Cloudflare Realtime 客戶端，5 秒逾時，上游錯誤一律轉成 `503 RELAY_UNAVAILABLE`）、`relay/index.ts`（`createRelayRoutes({ requireHost, requireMember })`）；RoomDO 新增 `getRelayPublication`／`registerRelayResource`／`getRelayResource`／`removeRelayResource`／`closeRelayResources`（獨立 storage key `relay`）；`services.ts` 新增 `RelayService`。
2. 介面變動：依既有契約啟用 `POST /api/rooms/:roomId/whip`、`POST /api/rooms/:roomId/whep`、`DELETE <Location>`；`Location` 為 `/api/rooms/:roomId/relay/:resourceId`（UUID）。shared 與 WebSocket 契約沒有變更。
3. 已知限制：WHIP／WHEP 不檢查 `room.mode`；若 SFU 要求額外 SDP 協商，WHEP 回 503；Realtime 沒有刪除 session 的 API，改為強制關閉 tracks；房主斷線、換片、關房時的清理時機待定（關房整合併入 T-114）。官方範例 `cloudflare/realtime-examples` 沒有明確授權條款，未複製程式碼，依官方 Connection API 與 OpenAPI schema 自行實作。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`（signal 64 個，上游一律用假 fetch）。

Review（Claude 監工）：路由沿用 `requireHost`／`requireMember`，沒有新的 log，錯誤回應不含金鑰與上游內容，沒有新增套件，`relay/` 沒有使用 Workers 專屬 API，改動範圍符合 ownership.md。合併前四項檢查全過。留給 T-109 確認：(a) 是否要求 `mode === 'relay'`；(b) WHEP 單次 offer／answer 能否在真實 SFU 運作（列入 T-113 實測）；(c) 房主重新 WHIP 時，舊的發布資源留在 storage，直到關房或 DELETE 才清掉。

### T-112（GPT，2026-11-24）— DONE
1. 做了什麼：根目錄 `pnpm deploy`（先 build web，再 `wrangler deploy --env production`）；`wrangler.toml` 新增 `[env.production]`，用 Workers static assets 由同一個 Worker 提供前端（`run_worker_first = ["/api", "/api/*"]`、SPA fallback、`workers_dev = false`），並重新宣告 vars、兩個 Durable Object 與 `JOIN_RATE_LIMITER`；`.github/workflows/ci.yml`（typecheck、lint、test、Chromium + Chrome e2e，失敗時上傳 Playwright 報告）；給零經驗使用者的 `docs/guides/deploy.md`。
2. 介面變動：無。正式 Worker 名稱為 `remote-sync-player-signal-production`。
3. 已知限制：repo 沒有 GitHub remote，CI 尚未在 GitHub 實跑；指南的 Cloudflare 後台截圖是佔位符；`pnpm deploy --dry-run` 會被 pnpm 內建指令吃掉旗標，預演請直接呼叫 wrangler；正式網域與中國大陸連線待 T-113 實測。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e`，以及 `pnpm --filter @project/web build && pnpm --filter @project/signal exec wrangler deploy --env production --dry-run`。

Review（Claude 監工）：沒有新增套件、沒有改 pnpm-workspace.yaml，CI 不含任何金鑰，四個 GitHub Action 版本都確認存在。接到 main 最新版本後四項檢查、build 與 dry-run 全過（dry-run 讀到 4 個靜態檔、兩個 DO、10 次/60 秒限流）。合併後順手更新指南一行（T-108 已合併）。執行過程中 GPT 曾誤觸 wrangler 的一般部署流程，在要求登入時就退出，沒有登入、上傳或部署。請 Claude 更新 development.md：pnpm deploy 的旗標行為、正式環境的 `--env production`、同源部署、CI 需要兩種瀏覽器。

決定（監工，2026-11-24）：移除 `PUBLIC_ORIGIN`。沒有程式讀取它；同源部署下前端用 `location.origin` 組邀請連結（`apps/web/src/lib/router.ts`），也不需要 CORS；WebSocket 用第一則 `auth` 訊息帶 token、不靠 cookie，不需要檢查 Origin。已從 `wrangler.toml` 與部署指南移除，`development.md` 的變數表由 Claude 移除。

### T-105、T-114 第一輪審查（GPT，2026-11-24）— 退回修正
- T-105（985a75b）：小修後可合併。阻擋項：房主開自己的邀請連結時 hostToken 被 memberToken 覆寫；房主重新驗證後前端不會依 protocol.md「房主重新連線」第 3 步重送 `live: true`。另有 4001／4003／4401 未導回首頁、房間到期後 WebSocket 握手 404 讓前端無限重試（規格缺口）等應修項。
- T-114（be84d81）：GPT 判「需重做」，監工核對後認定一項阻擋：閒置 alarm 排進佇列後，房主重新上線，但排隊中的關房不會重算 `closeAt`，房間仍被關閉。應修：關房先通知再提交交易；邀請目錄失敗會擋住 relay 清理，重試用完後 `deleteAll` 會刪掉待清理紀錄；WHIP 回滾失敗被吞掉；目錄 RPC 結果遺失會留下孤兒碼；`4000` 接手的送訊順序與規格相反；`4408` 後多一次 alarm；`closeRelayResources` 在測試中被計數器取代，常數時間比對的測試抓不到提早返回。「並發重產只有最後一碼有效」是依序執行的正常結果，改為修正 spec 文字。

### T-114（Claude，2026-11-24）— DONE
1. 做了什麼：重產邀請碼與關房在 RoomDO 內依序執行；關房先提交 closing 標記再通知，邀請碼與各 relay 資源各自清理、各自保存進度，alarm 重試（含首次共 12 次，放棄後保留未完成紀錄）；排隊中的關房取得執行權後重算 `closeAt`；換碼操作以 `opId` 查回結果；限流後備（`rate-limit.ts`）；token 常數時間比對；房主重新連線（含 `4000` 接手）的送訊順序；未驗證連線格式錯誤以 `4400` 關閉、五秒期限在雜湊後判定；房間不存在／已關閉／關房中／roomId 格式錯誤時 WebSocket 接受後以 `4001` 關閉。
2. 介面變動：protocol.md 新增「房主重新連線」「版本紀錄」（v1 未發布前不升版）、4001 涵蓋「連線時房間已不存在」；room-and-invite.md 補關房重試與限流後備。T-108 的公開方法 `RoomDO.closeRelayResources()` 改為私有的 `closeRelayTracks()`，由關房流程內部呼叫（repo 內無其他呼叫者，監工確認接受）。
3. 已知限制：見 T-116。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`（合併時根目錄 60 + signal 93、e2e 3 全過）。

Review（GPT 第二輪，監工核對）：結論「小修後可合併」。第一輪的阻擋項（房主回來後排隊中的關房仍執行）已修，四個反向實驗都會讓對應測試失敗。GPT 另列兩項阻擋：目錄換碼寫到一半失敗留下孤兒對照、relay 待辦的 alarm 沒排上。兩者都要先發生 storage 寫入失敗才會出現，孤兒碼不能拿來進房，SFU 也會自行回收 session，監工降為應修，與「SFU 回 410 仍重試 12 次」一起開為 T-116。

### T-105 第二輪審查（GPT，2026-11-24）— 退回修正
用 T-114 + T-105 合併後的版本驗收：檢查全過（Vitest 224、e2e 3），第一輪的房主身份覆寫、重新驗證後恢復直播、到期回首頁等項目大致通過。監工核對後認定一項阻擋：收看者第一次加入時沒有記住邀請碼和房間的對照，之後每點一次邀請連結都會呼叫 `POST /join`，伺服器留下離線成員，10 分鐘內就可能 `ROOM_FULL`。這輪一起修：長片名在 390px 撐寬版面（房主 533px、收看 473px）、開播失敗後手動重試沒有送出請求。其餘（舊分頁 4401 清掉新分頁 token、跨分頁停播後舊分頁自動開播、組合 emoji 截斷、身份檢查同時在途的筆數、忽略舊 ICE 回應的假綠測試、`host_closed` 文案、REST 與廣播亂序）可併入 T-116 或之後處理。

### T-115 第一輪審查（GPT，2026-11-24）— 退回修正
審查 93b2b40：檢查全過（Vitest 181、e2e 3），三個反向實驗都會讓對應測試失敗。審查角度是「T-107 只看契約能不能不猜就寫出 p2p/」。監工核對後同意退回，T-107 要等 T-115 修正並再審一次才派。阻擋項：`HostTransport` 沒有逐人關閉入口，被踢的收看者在 ICE 自然斷線前仍可收看；`rtc.ts` 把原生 transceiver 硬轉型成有 `kind` 的介面，H.264 偏好實際沒套用（fake 有 `kind`，所以測試全綠）；`stats.ts` 覆寫而非加總各 RTP 的位元組，RTT 與負 `packetsLost` 也會算錯；`destroy()` 與換片時的 track 所有權不清（不可 stop T-106 持有的 capture track）；房主重連與直播中切模式的事件順序和 protocol.md 不一致；answer 與 ICE candidate 的順序、型別（`string | undefined`）沒寫全；`remoteStream` 要用 `event.track` 加入；WHIP 何時算就緒（何時才能送 `live:true`）沒有定義。應修：狀態轉換表與重試計數、轉發不可用的錯誤碼、`setQuality` 的失敗回報、fake 的協商狀態要貼近真實 Chrome、工廠的匯出位置與整合負責人。


### T-115 第二輪審查（GPT，2026-11-24）— 退回修正
審查 7eb27c4：檢查全過（Vitest 188、e2e 3）。真實 Chrome 驗證 H.264 優先已生效，`event.track` 也已加入固定的 `remoteStream`。第一輪 13 項中 7 項已修、6 項部分修正。監工核對後確認三項阻擋：
- P2P 的 `start()` 要等 capture track 套到 sender 才 resolve，但 sender 要收到 `peer:request` 才會建立，兩者互等。§6 範例的 `stream:status` 少了必填的 `title`，停播會被拒絕，切模式時就會漏掉請求。
- 收看者只重建 transport 時，房主不會收到再發 offer 的觸發。§3 要房主送 `member:status`，但伺服器會擋下房主送的這則訊息。
- 第一次沒有音軌時，沒有替每種 kind 預留 transceiver，之後換成有聲片就加不回聲音。換片後重建 transport 時，也沒寫清楚要用 T-106 的哪一個 stream。

第四項「停止後立即重開轉發，晚到的舊 WHIP 會蓋掉新發布」屬於轉發的開停序列化，改列為 T-109 的必做項，若需要伺服器辨識發布世代則另開任務。應修：同一成員重複發出 `peer:request` 或 ICE restart 時，舊協商要整個作廢，並補上 restart 的 answer 期限；fake 要在套用遠端 offer 時自動建立接收 transceiver；統計缺值時的規則；T-109 單次 HTTP offer 的 ICE 收集方式，以及取得完整 `localDescription` 的入口。

> 2026-11-24 使用者決定：T-115 第二輪審查的修正改由 GPT 直接處理，Claude 這輪不動 T-115。分兩個子對話，依檔案切開，避免衝突：
> - `gpt/T-115-fix-contract`：`docs/specs/streaming.md`、`features/transport/index.ts`。
> - `gpt/T-115-fix-common`：`features/transport/common/`。
>
> 監工把兩個分支合併到 T-115 分支，再派審查，通過後才併入 main。

### T-115 第三輪審查（GPT，2026-11-24）— 退回修正（GPT 修）
審查 `gpt/T-115-fix-round2`（dc845d8，為 a652929 契約加上 dc845d8 common）：檢查全過（Vitest 211、e2e 3），Chrome 驗證三項都通過（H.264 優先、預留的 transceiver 不必重新協商就能補上音軌、ICE 收集完成後 SDP 含 candidate）。第二輪的阻擋項 (b)、(c)、(d) 已修，(a) 大致修好。

唯一阻擋：signal 的 offer 與 answer 沒有協商識別。房主停播後再開播時，新連線可能套用上一輪在途的 answer，正確的 answer 反而被拒（已用正式 adapter、process.ts 和 Chrome 重現）。監工決定這輪就補上協商識別，因為等 T-107 開工後再改協定，代價更高。改法如下：
- 房主為每份 offer（含 ICE restart）配發一個識別。
- answer 與 ICE candidate 都帶這個識別。
- 房主比對不符就丟棄。
- 先改 protocol.md 和 shared，再改規格。

應修：
- 收看者等不到第一份 offer 時要逾時，並提示重新連線。
- fake 做 ICE restart 時要換 ufrag；連線關閉後，sender 的操作要報錯。
- 補齊 protocol.md:40、room-and-invite.md:10、process.ts:172 三處 stream:status 範例的 `title` 與 `startedAt`。

留給 T-109：
- WHIP 首次發布缺軌時要保留哪些 media sections。
- relay 的 `removePeer` 由誰負責。
- DELETE 回應遺失、重試拿到 403 時，怎麼確認已經清理完成。

### T-115（Claude 實作，第二至四輪由 GPT 修正，2026-11-24）— DONE
1. 做了什麼：
   - 完成傳輸層契約 `features/transport/index.ts`，提供 `createHostTransport` 與 `createViewerTransport`，以及 `common/` 底下的 emitter、encoding、errors、ice、ice-gathering、rtc（真正的 adapter，記下 kind，正規化 candidate 與 SDP）、rtc-fake（貼近 Chrome）、stats。
   - streaming.md 寫明 P2P 協商順序、每個成員各自的 ICE 佇列、協商識別比對、ICE restart 與期限、模式切換「先停再開」、房主與收看者的重連、晚加入、track 所有權、影音各預留一個 transceiver、WHIP 開停序列化、單次 HTTP offer 的 ICE 收集，以及統計缺值的規則。
2. 介面變動：
   - shared 的 `signal.data` 新增必填的 `negotiationId`（1–64 字元，offer、answer、ice 都要帶，含 `null` 結束標記）。protocol.md 已同步更新，協定版本維持 1。
   - `HostTransport` 新增 `removePeer`；`start()`、`setQuality()` 改為回傳 Promise；`sendSignal` 改為回傳 boolean。
   - `TransportErrorCode` 新增 `STREAM_NOT_LIVE` 與 `RELAY_UNAVAILABLE`。
   - RTC adapter 新增 `localDescription` 與 `waitForIceGatheringComplete`。
3. 已知限制：
   - 依 mode 分派 p2p／relay 的 dispatcher，等 T-107、T-109 合併後由 Claude 補上。
   - 「使用者選擇前就停用轉發」需要伺服器提供能力旗標，另開任務。
   - T-109 必做：WHIP 首次發布缺軌時要保留哪些 media section、relay 的 `removePeer` 由誰負責、DELETE 回應遺失且重試拿到 403 時怎麼確認已清理。
   - T-107 驗收：同一條 WebSocket 上的舊 answer 延遲交付、ICE restart 3 次上限、換代中的非同步回呼、首份 offer 逾時後重新連線的完整流程。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`（Vitest 229 = web／shared 136 + signal 93，e2e 3）。第四次 GPT 審查用 Chrome 158 搭配實際的 process.ts，重播「舊 answer 晚到」的情境，確認舊 answer 對 RTC 的呼叫為 0 次，新連線能完成協商。

合併（監工，2026-11-24）：從 `claude/T-115-transport-arch`（7eb27c4）合入以下修正：
- `gpt/T-115-fix-contract`、`gpt/T-115-fix-common`（第二輪修正）
- `gpt/T-115-fix-r3-negotiation`、`gpt/T-115-fix-r3-fake`（第三輪修正）
- 監工第四輪的小修：同一條連線 ICE restart 時保留 `remoteStream` 的 track；fake 在遠端換證時重設當次的 ICE 狀態

全部 rebase 到 main 後 fast-forward 合併（main = 065b280）。解鎖 T-107（GPT，派工中）與 T-109（Claude）。T-110 仍要等 T-105。

### T-107（GPT，2026-11-24）— DONE
1. 做了什麼：
   - `features/transport/p2p/` 匯出 `createP2PHostTransport` 與 `createP2PViewerTransport`。
   - 房主：
     - 每位成員各建一條連線，影音各預留一個 sendonly transceiver。
     - 編碼：H.264 優先，音訊用 Opus，縮放依片源高度計算。
     - 每份 offer 配發新的 UUID 作為 `negotiationId`，比對不符就丟棄。
     - ICE 依成員、依協商代次各自排隊。
     - 逾時與重試：answer 等 15 秒；斷線 5 秒寬限；同一次斷線最多 restart 3 次，恢復連通後計數歸零。
     - `removePeer` 冪等。
     - 畫質更新逐人回報失敗。
   - 收看者：
     - 使用固定的 `remoteStream`，track 用 `event.track` 加入。
     - 同一條連線 ICE restart 時保留 track，以 SDP `o=` 的 session id 判斷是不是同一條連線。
   - 統計每 2 秒取樣一次，換代時重設取樣基準。
2. 介面變動：無，照 T-115 契約實作。
3. 已知限制：
   - 以下由房間層處理：首份 offer 的 20 秒期限、重新驗證、60 Mbps 總頻寬提示。
   - 同一條連線的兩次 ICE 收集重疊時，無法歸屬的、沒有 ufrag 的事件會略過。
   - 實測只做到本機兩端；跨網路 TURN、跨裝置與多人負載留待 T-113 或實機驗收。
4. 驗證方式：
   - `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`：Vitest 255（含 P2P 26），e2e 3。
   - 4 個反向實驗（拿掉協商識別比對、丟棄提早到的 ICE、restart 時清空 track、允許第 4 次 restart），每個都讓對應的測試失敗。
   - 本機 Chrome 158 兩端實測：舊 answer、舊 ICE 對 RTC 的呼叫為 0 次；新協商收到 74 個 H.264 影格與 Opus 音訊；restart 後會換證，並保留 receiver。

審查與合併（監工，2026-11-24）：
- 變更只在 `p2p/` 的 9 個檔案，沒有新增套件，也沒有 log 或 token 外洩。
- 監工逐段核對 host、host-peer、negotiation、viewer 與規格（§3、§9 狀態表），沒有發現阻擋項。
- 監工重跑四項檢查全部通過，以 fast-forward 合併。
- GPT 回報給 Claude 的兩個小項目，可併入 T-116 或 dispatcher 任務：
  - `common/encoding.ts:57` 的 `preferredVideoCodecs` 註解寫「移除其他 video codec」，實際程式會保留其他 codec，排在 H.264、VP8 之後，請修正註解。
  - `rtc-fake` 產生的 SDP 沒有 `o=` 行，P2P 測試要自己寫含 `o=` 的 SDP，fake 可以補上。

### T-105（Claude，2026-11-24）— DONE（帶著已知問題合併）
使用者指示直接合併。這時 `claude/T-105-pages` 停在 ce96251，也就是第一輪修正，第二輪審查退回的 3 項都還沒修。監工把分支 rebase 到 main（a6a7f91），沒有衝突，四項檢查全過（Vitest 326 = web／shared 233 + signal 93，e2e 3），fast-forward 合併，main = da9db85。

第二輪退回的 3 項改列為 T-117，交給 Claude。其中「收看者沒記住邀請對照」屬阻擋級，要在 T-110／T-111 之前修好。第二輪其他次要項目照原決定併入 T-116。

### T-117（Claude，2026-11-24）— DONE
1. 做了什麼：
   - 收看者第一次加入、或沿用既有身份加入時，都記住邀請碼與房間的對照。之後再點同一個邀請連結，先用 `GET /ice` 確認身份，有效就直接回房。
   - 長片名不再撐寬 390px 版面。
   - 開播失敗後可以手動重試。
2. 介面變動：無。
3. 已知限制：見下方審查。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`，加上本機 Chrome 390×844 實測。

審查（GPT fast，cd7aec3）判「需退回」，監工核對後分兩類處理：

監工直接小修（bf5aa8c）：
- 換片途中斷線會取消開播意圖，重新連線後不再補送開播（相對 bba904b 的退步）。改法：新增 `SignalDisconnectedError`，區分連線中斷和伺服器拒絕。
- 較舊的請求失敗時仍會顯示錯誤。
- 收看頁長片名仍會撐到 528px。

降級併入 T-116：「有效成員多佔一席」。這只在以下兩種情況發生：
- `GET /ice` 剛好暫時失敗。
- 房主換碼後，既有成員點了新碼。

這兩種情況都不常見，而且要改協定才修得好。

合併：四項檢查全過（Vitest 335 = web／shared 242 + signal 93，e2e 3），反向實驗 2 個，各讓 1 個測試失敗。fast-forward 合併。

> 2026-11-24 Claude 回報：房主端接上傳輸層的工作還沒有人負責，這會阻擋 T-111 與實際觀看。監工新增 T-118 交給 Claude，T-111 也改成依賴 T-118。T-110 是從 T-117 原始分支開出來的。監工把它 rebase 到 main（5b41d2f），解決 `RoomPage.tsx` 收看區的衝突：保留 T-110 的播放器，並沿用 T-117 小修加的 `grid-cols-[minmax(0,1fr)]`。rebase 後四項檢查全過（Vitest 365 = web／shared 272 + signal 93，e2e 3），已送審。
