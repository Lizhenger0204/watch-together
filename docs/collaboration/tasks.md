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
| T-111 | E2E：3 個 context 的 P2P 流程 | GPT | T-105, T-106, T-107, T-110, T-118 | TODO |
| T-112 | 部署：給零經驗使用者的 Cloudflare 帳號與網域設定圖文指南、`pnpm deploy`、secrets 設定、CI | GPT | T-103 | DONE |
| T-113 | 人工驗收清單（ADR 0002 待驗證項目），做完後交給使用者與朋友實測 | Claude | T-111, T-112, T-122 | TODO |
| T-114 | T-103 審查修正：邀請碼重產與關房序列化、關房清理可重試、限流後備、token 常數時間比對；spec 補房主接手（4000）時的 `peer:request` 順序、未驗證連線格式錯誤以 4400 關閉、ICE 新路徑同步 shared 與版本說明；關房時呼叫 `RoomDO.closeRelayResources()`（失敗保留記錄重試） | Claude | T-103, T-108 | DONE |
| T-115 | 傳輸層共用架構：`createHostTransport` / `createViewerTransport` 介面、`features/transport/common/`（編碼與畫質、ICE 設定取得、狀態事件、統計共用部分）、模式切換流程，寫進 streaming.md；給 T-107（GPT）與 T-109 共用 | Claude | T-102 | DONE |
| T-116 | T-114 第二輪審查的後續修正：邀請目錄換碼改為單一交易（不留孤兒對照）；relay 清理待辦、重試狀態與 alarm 一起提交；SFU 回 `410 session_error` 時視為已結束、不重試；可考慮 WebSocket upgrade 每 IP 限流；protocol.md 4408 改為「5 秒內未完成驗證」；room-and-invite.md「前端以最後收到的回應為準」改為前端序列化重產或以 snapshot 校正；**T-117 審查：有效成員多佔一席**（已知邀請對照遇到 `GET /ice` 暫時失敗時改走 `POST /join`；房主換碼後既有成員點新碼會再配一席，房間已鎖或已滿時回 404／409），需要先改 spec 與 shared，讓持原房憑證的人在配置席位前比對邀請碼、沿用既有成員 ；T-105 第二輪審查併入的次要項目；T-107 合併時回報的兩項（`common/encoding.ts:57` 註解、rtc-fake 的 SDP 補 `o=` 行） | GPT | T-114 | REVIEW |
| T-117 | T-105 第二輪審查遺留修正（T-105 未修完即合併）：**收看者第一次加入時要記住邀請碼與房間的對照**（現在每點一次邀請連結都會 `POST /join`，伺服器累積離線成員，10 分鐘內可能 `ROOM_FULL`，屬阻擋級）；長片名在 390px 撐寬版面；開播失敗後手動重試沒有送出請求 | Claude | T-105 | DONE |
| T-118 | 房主端接上傳輸層（房間層）：開播時建立傳輸並開始送畫面、換片時更新 track（replaceTrack）、踢人或收看者離線時 `removePeer`、直播中切模式（streaming.md §6「先停再開」）、開播前 60 Mbps 總上傳量提示；依 mode 分派 p2p／relay 的 dispatcher（relay 部分等 T-109） | Claude | T-107, T-110, T-115 | DOING |
| T-119 | T-110 審查後續（收看端）：實際停格（影格與接收量不再前進）時要回報 `buffering`，恢復後清除；收看分頁被 `4000` 取代後要清理該代傳輸、PC 與計時器；首個 snapshot 前到的信令要以新 socket 為單位暫存，等 snapshot 確認直播後再交付；停播後切模式時，新傳輸的建立時點對齊 §6（`room:updated` 時建立） | GPT | T-110 | DONE |
| T-120 | 轉發伺服器端補強（T-109 回報）：**踢人或成員移除時關閉該成員的 WHEP 資源**（目前只在關房時清理，被踢的收看者在轉發模式下仍可收看，屬阻擋級）；房間是 p2p 模式時 WHIP／WHEP 回 409；新的 WHIP 登記成功時關閉上一個 publication 的 tracks | GPT | T-109, T-116 | TODO |
| T-121 | T-116 交回 Claude 的前端項目：記憶體房主的「多佔一席」（`roomToken` 提供可列舉房號的介面並接到 `identity.ts`）；舊分頁收到 WS 4401 時只清自己那份憑證；被 4000 取代或另一分頁明確停播時讓舊開播意圖失效；片名截斷以 `Intl.Segmenter` 不切斷組合 emoji；`signal.test.ts` 舊 ICE 回應的假綠測試；`host_closed` 依 `closedBy` 顯示文案；重產邀請碼的 REST 回應晚於廣播或 snapshot 時要忽略 | Claude | T-116, T-118 | TODO |
| T-122 | 轉發整合（T-109 審查遺留）：**WHIP 在套用 answer 期間停止會卡住同房間的下一次發布**（依 POST 進度處理取消：已取得 `Location` 時立即執行冪等 DELETE，讓 `start()` 不必等已關閉的原生 RTC 操作就能結束）；**收看端 WHEP 409 被房間層當成失敗**（`viewer-session` 收到當代的 `STREAM_NOT_LIVE` 時維持 `waiting`，下一個開播廣播重新拉流一次）；缺少有效本機 offer 時 `start()` 誤報成功；單次 DELETE 沒有逾時；合法的同源絕對 `Location` 被拒；同一次斷線重複發出錯誤事件。全部修好後，才把 `transport/index.ts` 的 dispatcher 接到 `relay/` | Claude | T-109, T-118, T-119 | TODO |

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

> 2026-11-24 T-116（`gpt/T-116-followups`，b409ecb，7 個 commit）完成，送 GPT 審查。這次含協定變更：`POST /api/rooms/join` 新增選填的 `existingRoomId`（搭配 Bearer 沿用原成員，回 `reused: true`）與 `excludeRoomIds`。A4（WebSocket upgrade 依 IP 限流）評估後維持現況，因為同一 NAT 後面八個人連線，重連額度就不夠用。超出 T-116 檔案邊界的 7 項列為 T-121（Claude）。

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

