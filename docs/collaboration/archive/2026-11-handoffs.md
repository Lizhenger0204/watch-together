# 交接備註封存（2026-11）

> 已完成任務與歷次審查的紀錄，從 tasks.md 搬來。平常不必讀；查某個任務的來龍去脈時再看。

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

### T-110（Claude，2026-11-24）— DONE
1. 做了什麼：
   - 收看端播放器 `features/player/`：原生 `<video srcObject>`、「點擊開始觀看」、狀態提示與重新連線、音量與全螢幕。
   - 收看者房間層 `features/room/viewer-session.ts`：依 snapshot、stream:status、room:updated 建立與銷毀傳輸；暫存信令；首份 offer 20 秒期限；手動重連時先重建 socket 再重新驗證；每 5 秒送 member:status。
   - `transport/index.ts` 補上 dispatcher。
2. 介面變動：dispatcher 沿用 T-115 的工廠型別，T-107 原有的 26 個 P2P 測試全部通過。
3. 已知限制：房主端要等 T-118。WHEP 收到 `STREAM_NOT_LIVE` 時回到等待，留給 T-109。
4. 驗證方式：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`。

審查（GPT fast，6f89b1f）判「需退回」。阻擋項是 `<video autoPlay>`：從邀請頁按「加入」後，Chrome 把那次點擊算成使用者手勢，所以「點擊開始觀看」覆蓋層還在時就播出了聲音（實測 RMS 0.0427）。審查也實測確認以下功能正常：直播中加入、停播重開、房主重新驗證、收看者手動與自動重連、首份 offer 20 秒逾時、每 5 秒送一次 member:status、390px 版面、衝突解決。

監工小修（e72196b）：
- 移除 autoPlay，一律等點擊後才 `play()`。
- 連線失敗時，即使還沒按過開始觀看，也直接顯示「重新連線」。
- `play()` 失敗時，除了換流造成的 AbortError，其餘都恢復覆蓋層。

監工在本機 Chrome 158 用 T-107 房主探針實測：加入後 5 秒內 `paused=true`，點擊後開始播放，audioEnergy 0.13。

其餘應修列為 T-119：停格偵測、分頁被 4000 取代後的清理、snapshot 前信令的暫存、停播後切模式的建立時點。

合併：rebase 到 main（6009830）後四項檢查全過（Vitest 365 = web／shared 272 + signal 93，e2e 3），以 fast-forward 合併。

### T-119（GPT，2026-11-24）— DONE
1. 做了什麼：
   - 播放器以實際呈現的影格、播放時間與接收碼率判斷停格與恢復，回報 `buffering` 並在恢復後清除。純音訊片源會先用隱藏的 `<audio>` 播放，影像第一格到了再交回 `<video>`。
   - `ViewerSession` 訂閱 `SignalClient.onState`：收到 4000（取代）、關閉或重連時，立即釋放舊連線、遠端 track、取樣與回報計時器。
   - 首份 snapshot 前到的信令，以 socket 為單位暫存，上限 128 則。
   - 停播後切模式：在 `room:updated` 預先建立新傳輸，開播時再啟動。
2. 介面變動：
   - `ViewerSessionClient` 多用 `SignalClient` 原有的 `onState`。
   - `ViewerSession` 新增 `getReceiveBitrate`；`setBuffering` 會核對 stream 是否為當代。
   - `use-room.ts` 不用改，現有的 attach 已能處理 4000。
3. 已知限制：
   - 暫存滿 128 則後，只接受新的 offer。
   - relay 的 WHEP 順序只用 fake 驗證，實際行為待 T-109。
4. 驗證方式：
   - 四項檢查（Vitest 379 = web／shared 286 + signal 93，e2e 3）。
   - 6 個反向實驗，對應的測試都會失敗。
   - 本機 Chrome 158：100% 封包遺失時 2.54 秒回報 `buffering`、恢復後回到 `playing`；收到 4000 後 6.2 秒內 PC、track 與計時器都是 0；切回 P2P 再開播時，房主收到 1 次 `peer:request`。

審查與合併（監工，2026-11-24）：
- 變更只在 `viewer-session.ts`（及測試）與 `features/player/`，共 5 個檔案，沒有碰 T-118 範圍。
- 監工核對：`use-room` 每條 socket 都會建立新的 `SignalClient` 與 `ViewerSession`，所以手動重連時先 `destroy()` 再換 socket 是正確的。純音訊用的 `<audio>` 也是點擊後才 `play()`，不違反「點擊開始觀看」。
- 監工重跑四項檢查全過，以 fast-forward 合併。

### T-109（Claude，2026-11-24）— DONE（未接上 dispatcher）
1. 做了什麼：`features/transport/relay/`。
   - WHIP 房主：一條上傳連線，影音各預留一個 sendonly。201 而且已套用 answer 之後，`start()` 才 resolve。
   - WHEP 收看者：recvonly，`remoteStream` 固定；ICE 連通後才算 playing；409 時回到 waiting，並回報 STREAM_NOT_LIVE。
   - `http.ts`：POST／DELETE 用 Bearer；`Location` 只接受同源、本房間的路徑；DELETE 依 1／2／4 秒重試，403 與 404 視為已清理。
   - `publish-queue.ts`：同一頁面、同一房間的 WHIP 依序進行。
   - 單次 HTTP offer：最多等 2 秒 ICE 收集，再讀 `localDescription`。
2. 介面變動：無，照 T-115 契約。relay 的 `removePeer` 是 no-op。
3. 已知限制：
   - T-108 (a)～(c) 的回答，以及伺服器端事項（成員移除時關閉 WHEP、p2p 模式拒絕 relay、新的 WHIP 取代舊發布），開為 T-120。
   - 真實 SFU 上的協商留待 T-113。
4. 驗證方式：四項檢查全過，5 個反向實驗；Chrome 產生的 WHIP／WHEP SDP 通過伺服器的 `readOffer`。

審查（GPT ultra fast，61ae89a）判「需退回」：
- 阻擋 2 項：WHIP 在套用 answer 期間停止會卡住下一次發布；WHEP 409 被房間層當成失敗。
- 應修 4 項：缺少 offer 時 `start()` 誤報成功、DELETE 沒有逾時、同源的絕對 `Location` 被拒、錯誤事件重複發出。
- 已確認的正常行為：缺軌時保留影音兩段、4K 縮放、H.264／Opus 偏好、token 只放在 header、DELETE 的時序、伺服器 `readOffer` 相容。

監工處理：使用者指定「T-109 → tidy」依序合併。`transport/index.ts` 的 dispatcher 還沒接到 `relay/`，所以這些問題目前碰不到使用者。決定先合併，全部遺留問題開為 T-122，修完後才接上 dispatcher。另外，伺服器端「上游需要額外協商而關閉 track 時回 503」那條清理路徑，併入 T-120。

### tidy（Claude，2026-11-24）— 合併
- 把 p2p 與 relay 共用的 `isIceConnected`、`loadIceServers` 和測試替身收進 `common/`。純搬移，行為不變。
- 已完成任務的交接備註搬到本封存檔；ADR 0001 縮短；AGENTS.md 新增兩條守則。
- 加入 `.githooks/pre-commit`：單一檔案超過約 20 KB 就拒絕提交。`prepare` 會設定 `core.hooksPath`。
- 新增 e2e `layout.spec.ts`：390px 寬時長片名不得把版面撐寬。

使用者指定先合 T-109、再合 tidy。tidy 疊在 T-109 上，監工一起 rebase 到 main（5763f6a）。`tasks.md` 自動合併沒有衝突：tidy 封存的舊段落，加上 main 之後新增的段落。四項檢查全過（Vitest 418 = web／shared 325 + signal 93，e2e 4），以 fast-forward 合併。合併後已執行 `pnpm install`。

> 2026-11-24 T-116（`gpt/T-116-followups`，b409ecb，7 個 commit）完成，送 GPT 審查。這次含協定變更：`POST /api/rooms/join` 新增選填的 `existingRoomId`（搭配 Bearer 沿用原成員，回 `reused: true`）與 `excludeRoomIds`。A4（WebSocket upgrade 依 IP 限流）評估後維持現況，因為同一 NAT 後面八個人連線，重連額度就不夠用。超出 T-116 檔案邊界的 7 項列為 T-121（Claude）。

### T-116 第一輪審查（GPT ultra fast，b409ecb）— 退回修正（GPT 修）
可以無衝突 rebase 到 5763f6a，兩輪檢查都全過（rebase 後 Vitest 398，e2e 3）。Chrome 容量情境通過：ICE 503 期間 join 請求數為 0；換碼後沿用同一個 memberId；第 7 位新人回 200、第 8 位回 409。8 個反向變更都會讓測試失敗。A1、A2、A3、C、D 通過，A4 維持現況可以接受。協定的安全面：別房、已被踢、已關房的憑證都無法沿用；新人仍受鎖房與容量限制；限流涵蓋所有新路徑。

監工核對後，必修三項：
1. **自然淘汰的收看者拿到新邀請碼後永遠 404**：要用獨立的身份檢查確認舊憑證已失效，清掉後讓使用者能重新加入。
2. **舊分頁記憶體裡的 `null` 蓋過其他分頁寫入的有效憑證**：會多配一席，並覆寫有效憑證。要在加入鎖內重新核對跨分頁寫入的值。
3. **`excludeRoomIds` 沒有筆數與 body 上限**：先在規格定義上限，再在 shared 驗證；解析前限制實際讀入的量。

降為應修，同輪一起修：
- 滿房時，排除名單命中與否會回 404 或 409，洩漏「邀請碼對應哪個房號」。要先知道 roomId 才能利用，風險低。
- 規格要寫清楚：邀請碼已輪替後，點舊連結的語意。

監工補記授權：
- 本輪修正可改 `apps/web/src/lib/storage.ts`，僅限必修第 2 項。T-118 不動這個檔案，T-121 還沒開工。
- `apps/signal/test/` 的整合測試列入 T-116 的範圍。

### T-116 第二輪審查（GPT ultra fast，b3ac15d）與監工小修 — DONE
審查結果：第一輪 6 項都修好。
- 自然淘汰後用新碼重加，只配 1 席。
- 錯碼與暫時錯誤都保留身份。
- `excludeRoomIds` 上限為 16 筆、2,048 位元組，超限回 400；伺服器在解析前逐塊計數。
- 滿房回 409 且回應本文逐字相同，鎖房／已關閉／不存在共 12 個情境都回同一份 404。
- 快取的舊碼只當作回房捷徑。
- v1 版本紀錄已補。

新阻擋（第一輪修正帶進的回歸）：建房時第一次寫入憑證失敗，另一分頁以收看者加入後，原房主回房會變成收看者。監工依原則降為應修（需要先發生儲存寫入失敗），但後果嚴重而且修法小，就直接修掉（5869e20）：`readIdentity` 只在本分頁沒有身份，或記憶體的值本來就來自共用儲存時，才採用其他分頁的新值。同時修了應修項「淘汰後提示」，改為顯示「先前保存的房間身份已失效，請再按一次「加入」。」。

反向實驗 2 個：改回無條件採用時 2 個測試失敗，拿掉提示時 1 個失敗。其餘應修併入後續任務：
- 跨限流時窗的比對、無 Web Locks 時的協調 → T-121
- UUID 大小寫 → T-120

合併：四項檢查全過（Vitest 455 = web／shared 347 + signal 108，e2e 4），fast-forward 合併。

### T-120（GPT，2026-11-24）— DONE
1. 做了什麼：
   - 房主踢人、收看者最後一條連線關閉、新人加入時淘汰離線成員：都會清理該成員的全部 WHEP；只有離線時保留席位供重連。房間變更、清理待辦、重試狀態與 alarm 在同一筆交易提交（`runtime/workers/room-relay.ts`）。
   - p2p 模式下，WHIP／WHEP 在呼叫 SFU 之前就回 `409 STREAM_NOT_LIVE`；切回 p2p 時撤下所有發布與訂閱。
   - 新的 WHIP 登記與撤下舊發布在同一筆交易完成，並關閉舊發布與訂閱它的 WHEP。
   - 上游要求額外協商、關閉 track 也失敗時，已知的 session 與 tracks 會排進清理待辦。
   - `existingRoomId`／`excludeRoomIds` 驗證後統一轉成小寫。
   - 成員有 `relayGeneration`，被移除後才到的登記會被拒絕。
2. 介面變動：協定版本維持 1。被踢或被淘汰後，新的 WHEP 回 401；登記時才發現已被移除則回 403，並回滾 tracks；建立連線期間切離 relay 或建立者離線，回 409。
3. 已知限制：SFU 暫時關不掉 tracks 時，既有媒體可能持續到重試成功；真實 SFU 留待 T-113。前端的 409 提示區分交給 T-122。
4. 驗證方式：四項檢查（Vitest 467 = web／shared 347 + signal 120，e2e 4）；5 個反向實驗都讓對應的測試失敗。

審查與合併（監工，2026-11-24）：
- 變更 17 個檔案，都在授權範圍內，`apps/web` 沒有變更。
- 監工逐段核對 `room-relay.ts`：
  - 成員被移除時只撤下他的 WHEP（有 `publicationId` 的資源）。
  - 新的 WHIP 撤下舊發布與綁定的訂閱。
  - 用 `relayGeneration` 擋掉過期的登記。
- 唯一新增的 log 只記事件名稱，不含憑證。
- 超過 20 KB 的檔案（`room-do.ts`、`api.test.ts`、`streaming.md`）原本就在 allowlist；`api.test.ts` 有一部分測試拆到新檔，所以變小了。
- 監工重跑四項檢查全部通過，以 fast-forward 合併。

### T-123（GPT，2026-11-25）— DONE
1. 做了什麼：
   - 新增 `scripts/signal-dev.mjs`：用 Node 讀 `SIGNAL_PORT`（預設 8787，必須是 1～65535 的整數，不合法時報錯並以 1 結束），直接用 Node 執行 wrangler 套件宣告的 CLI，不經過 cmd.exe。
   - 收到 SIGINT／SIGTERM 時：macOS 轉送訊號；Windows 用 `taskkill /T /F` 結束 wrangler 和 workerd 整棵程序樹。
   - `apps/signal` 的 dev 改成呼叫這個腳本。
   - 根目錄的 test 加上 `node --test scripts/signal-dev.test.mjs`。
   - development.md 同步更新。
2. 介面變動：無，`WEB_PORT`／`SIGNAL_PORT` 的用法不變。
3. 已知限制：Windows 尚未實機驗證。驗證步驟見下方「Windows 驗證步驟」。
4. 驗證方式：
   - macOS 實測兩種情況：預設 5173／8787，以及指定 5403／9017。兩者 `/api/health` 都正常；Ctrl+C 後 20 個追蹤到的程序全部結束，port 都已釋放。
   - 四項檢查全部通過（啟動器 2 項、Vitest 467、e2e 4）。

審查與合併（監工，2026-11-25）：
- 只改 5 個檔案，沒有新增套件。
- 監工核對腳本，並實測 `SIGNAL_PORT=abc`：顯示錯誤訊息，結束碼為 1。
- 重跑四項檢查，全部通過，以 fast-forward 合併。

Windows 驗證步驟（PowerShell，在專案根目錄執行）：
1. 準備：`pnpm install --frozen-lockfile`。
2. 預設 port：
   - 執行 `Remove-Item Env:WEB_PORT, Env:SIGNAL_PORT -ErrorAction SilentlyContinue; pnpm dev`。
   - 另開一個視窗，執行 `curl.exe -fsS http://localhost:5173/api/health` 和 `curl.exe -fsS http://127.0.0.1:8787/api/health`。
   - 回到第一個視窗按 Ctrl+C。
3. 指定 port：執行 `$env:WEB_PORT='5403'; $env:SIGNAL_PORT='9017'; pnpm dev`，用 5403／9017 重複上面的 curl 檢查，再按 Ctrl+C。
4. 收尾檢查：執行 `Get-NetTCPConnection -State Listen -LocalPort 5173,8787,5403,9017 -ErrorAction SilentlyContinue`，應該沒有輸出。接著執行 `pnpm test`、`pnpm e2e`。

### T-118 第一輪審查（GPT ultra fast，6d1a837）— 退回修正
6d1a837 rebase 到 8b733cb 後沒有衝突。兩個版本四項檢查都全過（rebase 後 Vitest 397，e2e 3）。Chrome 三方實測（一位房主、兩位收看者）以下情境都通過：
- 開播、換片、自然播完後重播、停播與重開
- 畫質切換（8 Mbps）
- 踢人：房主的 PC 從 2 降為 1，被踢的人剩 0
- 房主重新整理後恢復
- 4000 接手
- relay fallback

監工核對後，列兩項必修：
1. **直播中換成無聲片會讓全房停播**：`sourceHolding()` 把可以由房主確認的 `warning` 送進 `stopLive()`。直播中等待房主確認時要保留傳輸，先換入 `null`，確認後再補上 video。
2. **切模式途中按停止，停播請求逾時後仍在出流**：`switchMode()` 失敗時沒有重讀意圖。要觸發這個情況，伺服器必須在連線還在時卡住，但房主已經明確停止了，所以仍列必修。

應修：
- 一般停播逾時後再重開，會顯示直播中，但沒有人收到畫面：要保留「停播尚未確認」的狀態。
- 片名請求沒有完整保留 T-117 的過期判斷：例如 `A → B → A` 會漏送最後的 A，空白片名轉成 `null` 也會漏送。
- `start()` 完成時若正在換片檢查，新片就緒後可能一直停在「直播暫停中」；`start()` 因斷線失敗時也要保留意圖。

建議：
- 切模式第 2 步要有等待廣播的期限。
- 60 Mbps 門檻可以保留，因為房間上限可以設定。

5 個保守判斷審查都認為合理，建議寫進 streaming.md §6、§9（由 Claude 改）。`host-session.ts`（23.5 KB）和它的測試（26 KB）超過 pre-commit 的上限，這次修正要按功能拆檔。

> 2026-11-25 T-118 第一輪修正完成（`origin/claude/T-118-host-transport`，66a7155，已 rebase 到 09a4b6c），送第二輪審查。host-session 已依功能拆檔，通過 pre-commit 檔案大小檢查。Claude 回報 Windows 上 signal 的 dev script 有問題，監工開 T-123 交給 GPT，與 T-118 審查同時進行。兩者不碰同樣的檔案。

### T-118（Claude，2026-11-25）— DONE
1. 做了什麼：
   - 新增 `features/room/host-session*`（房主的房間層，依功能拆成 9 個檔案）。
   - 開播：先 `await start()`，成功才送 `live:true`。
   - 停播：等 ack 或停播廣播之後，才 `stop()`／`destroy()`。
   - 換片：用 `replaceTrack`，不重建傳輸。無聲片等房主確認期間，先換成 `null`。
   - 畫質：收到 `room:updated` 之後才呼叫 `setQuality`。
   - 移除成員：比對 `room:members`，呼叫 `removePeer`。
   - 直播中切模式：照 §6 第 1～4 步，等 `room:updated` 最多 10 秒。
   - 房主重新連線：重建傳輸；收到 4000 時銷毀；顯示 60 Mbps 提示。
   - `stream:status` 只有 HostSession 會送出。
   - 5 個保守判斷寫進 streaming.md §6、§9。
2. 介面變動：無（transport、shared、protocol 都沒改）。
3. 已知限制：
   - relay 要等 T-122 接上 dispatcher。
   - 其餘應修併入 T-121。
4. 驗證方式：
   - 四項檢查全過。
   - Chrome 三方實測：開播、換片、重播、停播重開、畫質、踢人、重新整理恢復、4000 接手、relay fallback、無聲片換軌。

T-118 第二輪審查（GPT ultra fast，66a7155）：第一輪 8 項中 6 項通過，兩項部分修正，詳見上方第一輪審查段與本段。
- 唯一阻擋：切模式途中按停止，首個停播請求逾時後，要等重送的停播確認才停止出流。這段期間兩位收看者各多收到 12 格。
- 應修 3 項，建議 2 項。

監工小修（e6c3666）：
- 第 1 步失敗而且房主已按停止時，立刻 `stop()`／`destroy()` 本機傳輸，再由 `stopLive` 重送 `live:false`。
- 先確認停播、再開播的路徑，在確認之後重新判斷意圖、片源與模式（應修 1）。
- 反向實驗 2 個。其餘應修併入 T-121。

合併：rebase 到 main（d51dd31）之後，四項檢查全過（啟動器 2 + Vitest 494 = web／shared 374 + signal 120，e2e 4），以 fast-forward 合併。

### T-111（GPT，2026-11-25）— DONE
1. 做了什麼：
   - 新增 `e2e/p2p-playback.spec.ts` 與 `e2e/p2p-recovery.spec.ts`，共用的輔助程式放在 `p2p-media.ts`、`p2p-room.ts`、`room-pages.ts`。
   - 用三個 Chrome context（一位房主、兩位收看者）測 P2P 的 9 個情境：
     - 開播與觀看：點擊前 `paused` 為 true，點擊後影格、時間、音訊封包與音量都持續增加。
     - 換片：PC 不重建。
     - 播完重播：沿用原本的 PC。
     - 停播與重開。
     - 踢人。
     - 房主重新整理。
     - 收看者重新連線。
     - 切到轉發再切回：目前斷言 RELAY_UNAVAILABLE。
     - 390px 長片名。
   - ICE 攔截成空清單，WHIP／WHEP 一律中斷，不會打到外部服務。
   - `playwright.config.ts`：chrome 專案改成 workers 1、timeout 60 秒。
2. 介面變動：無，只改 `e2e/`。
3. 已知限制：T-122 接上 relay 後，要改寫「切到轉發再切回」這個案例。
4. 驗證方式：
   - 四項檢查（啟動器 2、Vitest 494、e2e 6，總計 30.65 秒）。
   - 兩份新的 spec 用 `--repeat-each=3` 跑，6/6 通過。
   - 反向實驗：加回 autoPlay、把 replaceTrack 改成重建傳輸，兩項 E2E 都會失敗。
   - 沒有發現產品 bug。

審查與合併（監工，2026-11-25）：
- 變更只在 `e2e/` 的 9 個檔案。
- 沒有固定的 `waitForTimeout`。
- 監工確認 ICE 與 WHIP／WHEP 都已攔截。
- 監工重跑四項檢查（e2e 6）全部通過，再用 `--repeat-each=2` 跑 P2P spec 也全部通過；跑完沒有殘留在監聽的 port。
- 以 fast-forward 合併。

