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
- 任務 `DONE` 後，把它的交接備註與審查紀錄移到 `archive/`（agent 平常不讀），本檔只留進行中的備註與仍有效的決定。
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
| T-109 | 轉發傳輸客戶端（`features/transport/relay/`，WHIP / WHEP，照 T-115 的介面），並回答 T-108 留下的 (a)～(c) | Claude | T-108, T-114, T-115 | DONE |
| T-110 | 收看端播放器：原生 `<video srcObject>`（沿用 T-106 的元件）、點擊開始觀看、狀態提示、重新連線按鈕 | Claude | T-105, T-115 | DONE |
| T-111 | E2E：3 個 context 的 P2P 流程 | GPT | T-105, T-106, T-107, T-110, T-118 | DONE |
| T-112 | 部署：給零經驗使用者的 Cloudflare 帳號與網域設定圖文指南、`pnpm deploy`、secrets 設定、CI | GPT | T-103 | DONE |
| T-113 | 人工驗收清單（ADR 0002 待驗證項目），做完後交給使用者與朋友實測 | Claude | T-111, T-112, T-122、部署到 Cloudflare | TODO |
| T-114 | T-103 審查修正：邀請碼重產與關房序列化、關房清理可重試、限流後備、token 常數時間比對；spec 補房主接手（4000）時的 `peer:request` 順序、未驗證連線格式錯誤以 4400 關閉、ICE 新路徑同步 shared 與版本說明；關房時呼叫 `RoomDO.closeRelayResources()`（失敗保留記錄重試） | Claude | T-103, T-108 | DONE |
| T-115 | 傳輸層共用架構：`createHostTransport` / `createViewerTransport` 介面、`features/transport/common/`（編碼與畫質、ICE 設定取得、狀態事件、統計共用部分）、模式切換流程，寫進 streaming.md；給 T-107（GPT）與 T-109 共用 | Claude | T-102 | DONE |
| T-116 | T-114 第二輪審查的後續修正：邀請目錄換碼改為單一交易（不留孤兒對照）；relay 清理待辦、重試狀態與 alarm 一起提交；SFU 回 `410 session_error` 時視為已結束、不重試；可考慮 WebSocket upgrade 每 IP 限流；protocol.md 4408 改為「5 秒內未完成驗證」；room-and-invite.md「前端以最後收到的回應為準」改為前端序列化重產或以 snapshot 校正；**T-117 審查：有效成員多佔一席**（已知邀請對照遇到 `GET /ice` 暫時失敗時改走 `POST /join`；房主換碼後既有成員點新碼會再配一席，房間已鎖或已滿時回 404／409），需要先改 spec 與 shared，讓持原房憑證的人在配置席位前比對邀請碼、沿用既有成員 ；T-105 第二輪審查併入的次要項目；T-107 合併時回報的兩項（`common/encoding.ts:57` 註解、rtc-fake 的 SDP 補 `o=` 行） | GPT | T-114 | DONE |
| T-117 | T-105 第二輪審查遺留修正（T-105 未修完即合併）：**收看者第一次加入時要記住邀請碼與房間的對照**（現在每點一次邀請連結都會 `POST /join`，伺服器累積離線成員，10 分鐘內可能 `ROOM_FULL`，屬阻擋級）；長片名在 390px 撐寬版面；開播失敗後手動重試沒有送出請求 | Claude | T-105 | DONE |
| T-118 | 房主端接上傳輸層（房間層）：開播時建立傳輸並開始送畫面、換片時更新 track（replaceTrack）、踢人或收看者離線時 `removePeer`、直播中切模式（streaming.md §6「先停再開」）、開播前 60 Mbps 總上傳量提示；依 mode 分派 p2p／relay 的 dispatcher（relay 部分等 T-109） | Claude | T-107, T-110, T-115 | DONE |
| T-119 | T-110 審查後續（收看端）：實際停格（影格與接收量不再前進）時要回報 `buffering`，恢復後清除；收看分頁被 `4000` 取代後要清理該代傳輸、PC 與計時器；首個 snapshot 前到的信令要以新 socket 為單位暫存，等 snapshot 確認直播後再交付；停播後切模式時，新傳輸的建立時點對齊 §6（`room:updated` 時建立） | GPT | T-110 | DONE |
| T-120 | 轉發伺服器端補強（T-109 回報）：**踢人或成員移除時關閉該成員的 WHEP 資源**（目前只在關房時清理，被踢的收看者在轉發模式下仍可收看，屬阻擋級）；房間是 p2p 模式時 WHIP／WHEP 回 409；新的 WHIP 登記成功時關閉上一個 publication 的 tracks；伺服器端「上游需要額外協商、關閉 track 時回 503」的清理路徑要交給既有的清理待辦重試；shared 的 UUID 統一轉小寫（或規定只收小寫並驗證），讓 `excludeRoomIds` 不會因大小寫不同而漏判 | GPT | T-109, T-116 | DONE |
| T-121 | T-116 交回 Claude 的前端項目：記憶體房主的「多佔一席」（`roomToken` 提供可列舉房號的介面並接到 `identity.ts`）；舊分頁收到 WS 4401 時只清自己那份憑證；被 4000 取代或另一分頁明確停播時讓舊開播意圖失效；片名截斷以 `Intl.Segmenter` 不切斷組合 emoji；`signal.test.ts` 舊 ICE 回應的假綠測試；`host_closed` 依 `closedBy` 顯示文案；重產邀請碼的 REST 回應晚於廣播或 snapshot 時要忽略；（T-116 第二輪）跨限流時窗記住已比對過的房間（持有 10 房以上身份時，不要每個時窗都從頭比對）；沒有 Web Locks 時的跨分頁加入協調（例如用 IndexedDB 登記進行中的加入）；（T-118 第二輪）片名請求配發序號、開始停播時讓舊序號失效（停播後舊片名被拒仍顯示錯誤、`B → C → B` 被第一個 B 的拒絕清掉）；`room:updated` 等待逾時後先依 snapshot 重新取得伺服器模式，不要直接用原模式重建；`confirmStop` 晚到的 ack 不覆寫 `serverLive`；streaming.md §9 刪掉「成員列表看到該收看者離線」的斷言 | Claude | T-116, T-118 | DONE |
| T-122 | 轉發整合第二步（第一步 bb6af68 已合併）：**接上 dispatcher 後，轉發在開播 ACK 抵達前失敗，房主仍顯示「直播中」，也沒送停播或 DELETE**（`host-session-base.ts` 的 `starting` 階段忽略了傳輸錯誤；要區分「傳輸啟動中」和「已就緒、等開播確認」，後者收到終止錯誤時取消意圖、銷毀傳輸、撤回已送出的開播，晚到的 ACK 不能恢復舊世代）；把 a8d94d9（dispatcher 接上 relay、E2E 改成攔截後回 503）rebase 上來，並改寫 `host-session.test.ts:82`（注入假的 fetch／ICE，WHIP 回 503 時顯示 RELAY_UNAVAILABLE 並取消意圖）；`postOffer()` 驗證標頭後就登記 Location，讓停止可以立刻清理；空 SDP 改回 `RELAY_FAILED`（在 relay 讀本機 offer 的邊界轉換）；E2E 收緊為「WHIP 恰好 1 次、WHEP 0 次」 | Claude | T-121 | DONE |
| T-123 | 工具鏈：`apps/signal` 的 `dev` script 用 `${SIGNAL_PORT:-8787}`，Windows cmd.exe 無法展開，Windows 上 `pnpm dev` 起不來。改成跨平台寫法（例如 node 包裝腳本讀環境變數再啟動 wrangler），並確認 `pnpm dev`、`pnpm e2e` 在 macOS 與 Windows 都能用 `WEB_PORT`／`SIGNAL_PORT` 錯開 port | GPT | — | DONE |
| T-124 | 介面改善計畫（SPEC／文件）：截圖檢查現有所有頁面，提出改善計畫給使用者挑選，同意後再實作；建議最先做，決定 T-125 的視覺方向。**由 Gemini 對話「登記播放器與聊天室功能需求」直接與使用者討論並完成實作**（含 `DESIGN.md` 與全站藍白扁平改版） | Gemini | — | DONE |
| T-125 | 播放器圖示化控制列（Gemini 主導，含 `features/source` 例外）：參考使用者提供的截圖，控制列改用圖示按鈕（播放／暫停、時間、音量、彈幕開關、畫質、劇院模式、全螢幕），每個按鈕都要有提示文字與 `aria-label`。做成共用的控制列元件，房主播放器（`features/source`，原本是 GPT 的 UI）與收看端播放器（`features/player`）共用。收看端只有音量、全螢幕、彈幕、聊天，不能暫停或拖進度。若要新增圖示套件，要確認沒有被標成 deprecated，並且符合冷卻期 | Gemini | T-124 | DONE |
| T-126 | 細緻畫質調整（Gemini 先改 spec，實作分工待定）：取代固定的畫質預設。房主在播放器的畫質面板用三條分段滑桿即時調整：解析度 720P～1080P（不超過片源）；位元率 8／10／15 Mbps／原片位元率；FPS 檔位待定（暫定 24／30／60／原片）。這是契約變更：先改 streaming.md §2、protocol.md、packages/shared 的 `QUALITY_PRESETS` 與 quality 型別，再改 `common/encoding`（`setQuality` 即時套用）與 UI。P2P 60 Mbps 總上傳量提示保留，但不強制 | Gemini | T-125 | DOING |
| T-127 | 聊天室與彈幕（Gemini 先改 spec，實作分工待定；暫不派工）：新增聊天訊息（protocol.md 與 shared schema）。不保留歷史紀錄，加入後只看得到之後的訊息；房主不需要禁言或刪訊息。伺服器仍要檢查成員身份、被踢的人不能發言、限流、長度上限，並以純文字顯示。房主與收看者都能發言。彈幕從右往左，有開關與密度設定，全螢幕時仍會顯示（全螢幕的對象改成播放器容器） | Gemini | T-125 | TODO |
| T-128 | 切模式第 2 步等待 `room:updated` 逾時（結果不明）的處理（T-121 第 11 項，與 streaming.md §6 現行條文衝突）：先改 §6，區分兩種情況——**被拒**（`ack ok:false`）時照原模式重建；**逾時**時不要重建，維持「直播暫停中」。再由 `SignalClient` 提供重新驗證的方法（例如 `resync()`），拿到新的 snapshot 後依 snapshot 的模式重建 | Gemini | T-121, T-122 | DONE |
| T-129 | **RoomDO 產品競態**（從不穩定測試查出）：加入與踢人都從記憶體的 `this.room` 算出新成員清單後才交給 `saveTransition()`，提交後才更新 `this.room`。兩個操作讀到同一份舊清單時，後寫的會蓋掉先前已成功加入的席位（新成員拿到 200，卻立刻驗證失敗）。`relay-lifecycle.test.ts:440` 50 輪中失敗 2 輪。要把會改寫房間狀態的操作序列化，範圍從讀取最新狀態、計算變更，一直到提交交易、更新記憶體，並補上能穩定重現的回歸測試 | GPT | T-120 | DONE |
| T-130 | T-121 審查遺留（前端）：重產邀請碼期間收到「同碼」的鎖房／畫質廣播後 WS 中斷，成功的 REST 新碼被捨棄（改以單調遞增 `inviteCodeVersion` 與跨分頁共用儲存排序，畫面採用有效碼後才提示成功）；`tab-lock.test.ts` 改用假時鐘，不依賴真實的 `setTimeout`；`identity.ts` 的 `comparedRooms` 在身份清除時淘汰對應項，並限制保留數量；**伺服器已配位、分頁尚未保存身份就關頁會多一席**——加入請求帶冪等鍵 `joinKey`，已更新 protocol.md、room-and-invite.md 與 shared | Claude | T-121, T-129 | DONE |
| T-131 | T-122 審查遺留（轉發）：收看端 relay `start()` 在套用 answer 前後已失敗時要拒絕並清理（比照房主端的 `ensureNotFailed`）；`ANSWER_TIMEOUT_MS` 補上獨立斷言（改成 20 秒時測試要失敗）；E2E 若可行，加上 SFU 替身的影音流程 | Gemini | T-122 | DONE |
| T-132 | BUG-001：房主關閉瀏覽器後自動退房；先確認斷線／重整語意並更新契約，再補心跳、生命週期與回歸測試（詳見 [bugs.md](bugs.md)） | GPT 子線程 1（使用者指定） | — | DOING |
| T-133 | BUG 清單修復（詳見 [bugs.md](bugs.md)）：BUG-003 無法播放 HEVC（H.265）影片（GPT 的 `e2e/source.spec.ts` 斷言同時接受「檢查通過」與「影像無法解碼」，故測試期間未顯現）。需先收集實測環境與片源格式並排查 `features/source/` 解碼與試播流程 | GPT 子線程 3（使用者指定） | — | DOING |
| T-134 | BUG-002：明確退房、清除身份與釋放空房；與 T-132 對齊契約並補回歸測試（詳見 [bugs.md](bugs.md)） | GPT 子線程 2（使用者指定） | T-132 契約 | DOING |

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

> 2026-11-24 使用者決定：T-116、T-119 改由 GPT 負責，分兩個子對話。Claude 同時進行 T-118。這是 ownership.md 中 Claude 目錄的**單次例外**，只限這兩個任務。檔案邊界如下：
> - **T-116（`gpt/T-116-followups`）可改**：
>   - `apps/signal/src/` 的 `room/`、`signaling/`、`runtime/`、`relay/`、`app.ts`。
>   - `packages/shared`（若需改契約，先改 protocol.md）。
>   - `docs/specs/protocol.md`、`room-and-invite.md` 的相關段落。
>   - `apps/web/src/features/room/identity.ts` 及其測試。
>   - `features/transport/common/encoding.ts` 的註解。
>   - transport 的 rtc-fake。
> - **T-116 不可改**：
>   - `features/room/use-room.ts`、`room-state.ts`、`live-intent.ts`、`features/room/index.ts`、`pages/`。這些屬於 T-118。
>   - T-119 的檔案。
>
>   需要動到時先回報監工，交給 Claude 併進 T-118，或之後再處理。
> - **T-119（`gpt/T-119-viewer-followups`）可改**：`features/room/viewer-session.ts` 及其測試、`features/player/`。
> - **T-119 不可改**：`use-room.ts` 等 T-118 範圍，需要時一樣回報。

> 2026-11-24 T-109（`origin/claude/T-109-relay`，61ae89a）與 T-118（本機分支 `claude/T-118-host-transport`，6d1a837，尚未推上 origin）都已完成，兩者都送 GPT 審查。T-109 已和 tidy 一起合併；dispatcher 改由 T-122 修完審查遺留問題後再接上，這之前轉發一律回 RELAY_UNAVAILABLE。T-118 待審查。
>
> T-109 回報的伺服器端問題開為 T-120（GPT），等 T-116 合併後再派，因為兩者都會改 `apps/signal/src/relay/`。T-108 留下的三個問題，T-109 的回答如下：
> - (a) 客戶端不需要，但建議伺服器在 p2p 模式回 409。
> - (b) 真實 SFU 能否運作，列入 T-113 驗收。
> - (c) 客戶端會先清理舊發布再送新的 POST；分頁當掉等情況留下的發布，由伺服器在新的 WHIP 登記時關閉舊發布。

> 2026-11-25 使用者決定（由主對話 Claude 轉達）：
> - P2P 基本流程已在本機實測正常。新功能不等 T-113；T-113 等部署到 Cloudflare 之後再做（Cloudflare 帳號與網域由使用者另開對話處理）。
> - 新增 T-124～T-127。建議順序：T-122、T-121、T-124 平行 → T-125 → T-126、T-127 平行；T-113 在部署之後。
> - T-125 會改到 `features/source`（原本是 GPT 的 UI），由 Claude 主導，這是使用者核可的例外。
> - T-121、T-122 由監工派給 Claude 子對話，各自用自己的 worktree。檔案邊界：
>   - **T-122**（`claude/T-122-relay-integration`）可改 `features/transport/relay/`、`features/transport/index.ts`、`features/room/viewer-session.ts`（只限 WHEP 409 那一項）。
>   - **T-121**（`claude/T-121-frontend-followups`）可改 `features/room/`（不含 `viewer-session.ts`）、`lib/`、`pages/`，以及 streaming.md §9 的那一句。
>   - 兩者都不改 `apps/signal/`、tasks.md、main。
> - `claude/test-session-docs`（測試對話規範）刻意先不送審，等功能全部完成後再處理。



> 2026-11-25 注意：監工合併 T-122 時發現，有人直接在 main 工作目錄留下未提交的修改（09:03）：`apps/signal/src/config.ts` 改用 `WS_AUTH_TIMEOUT_MS`、ADR 0002 加註「ADR 0001 已刪除」、`transport/index.ts` 改了 `relayNotReady()` 的註解。監工已用 `git stash` 暫存（stash@{0}），合併後放回。`transport/index.ts` 的那一處因為 T-122 已刪掉該函式，改用 T-122 的版本；另外兩處留在工作目錄、**未提交**，等修改者走分支流程送審。**只有監工能改 main，請改在自己的分支 commit。**

> 2026-11-25 使用者決定（由 Gemini 對話「登記播放器與聊天室功能需求」轉達）：
> - 因 Claude 額度暫時不足，**T-124、T-125、T-126、T-127** 暫時改由 **Gemini** 負責執行（屬 `ownership.md` 的暫時分工調整）。
> - **T-124** 已由 Gemini 對話「登記播放器與聊天室功能需求」與使用者定案並完成合併（`DONE`）；**T-125～T-127** 維持 `TODO`，待使用者指示再開工。
> - T-125 的 `features/source` 例外同樣由 Gemini 主導；跨模組契約與實作仍依既有流程交由 GPT 審查。


### T-126（GPT 監工審查，2026-11-25）

- T-126（`76ec120`，依賴 T-125）：Chrome 元件測試已重現延遲房間廣播時最後一次畫質選擇遺失，以及 1000P 片源無法由預設直接選 900P。請補上請求失敗後的面板校正與這兩種情境的回歸驗收。
- 複驗（`68cd868`）：Chrome 重現先鎖房、調到 10 Mbps，延後畫質廣播後再改 FPS，第二筆畫質請求會送出 8 Mbps。無關的鎖房廣播被算成畫質確認，請針對這個情境修正並複驗。
