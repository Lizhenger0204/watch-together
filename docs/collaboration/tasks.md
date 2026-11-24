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
| T-109 | 轉發傳輸客戶端（`features/transport/relay/`，WHIP / WHEP，照 T-115 的介面），並回答 T-108 留下的 (a)～(c) | Claude | T-108, T-114, T-115 | TODO |
| T-110 | 收看端播放器：原生 `<video srcObject>`（沿用 T-106 的元件）、點擊開始觀看、狀態提示、重新連線按鈕 | Claude | T-105, T-115 | DONE |
| T-111 | E2E：3 個 context 的 P2P 流程 | GPT | T-105, T-106, T-107, T-110, T-118 | TODO |
| T-112 | 部署：給零經驗使用者的 Cloudflare 帳號與網域設定圖文指南、`pnpm deploy`、secrets 設定、CI | GPT | T-103 | DONE |
| T-113 | 人工驗收清單（ADR 0002 待驗證項目），做完後交給使用者與朋友實測 | Claude | T-109, T-111, T-112 | TODO |
| T-114 | T-103 審查修正：邀請碼重產與關房序列化、關房清理可重試、限流後備、token 常數時間比對；spec 補房主接手（4000）時的 `peer:request` 順序、未驗證連線格式錯誤以 4400 關閉、ICE 新路徑同步 shared 與版本說明；關房時呼叫 `RoomDO.closeRelayResources()`（失敗保留記錄重試） | Claude | T-103, T-108 | DONE |
| T-115 | 傳輸層共用架構：`createHostTransport` / `createViewerTransport` 介面、`features/transport/common/`（編碼與畫質、ICE 設定取得、狀態事件、統計共用部分）、模式切換流程，寫進 streaming.md；給 T-107（GPT）與 T-109 共用 | Claude | T-102 | DONE |
| T-116 | T-114 第二輪審查的後續修正：邀請目錄換碼改為單一交易（不留孤兒對照）；relay 清理待辦、重試狀態與 alarm 一起提交；SFU 回 `410 session_error` 時視為已結束、不重試；可考慮 WebSocket upgrade 每 IP 限流；protocol.md 4408 改為「5 秒內未完成驗證」；room-and-invite.md「前端以最後收到的回應為準」改為前端序列化重產或以 snapshot 校正；**T-117 審查：有效成員多佔一席**（已知邀請對照遇到 `GET /ice` 暫時失敗時改走 `POST /join`；房主換碼後既有成員點新碼會再配一席，房間已鎖或已滿時回 404／409），需要先改 spec 與 shared，讓持原房憑證的人在配置席位前比對邀請碼、沿用既有成員 ；T-105 第二輪審查併入的次要項目；T-107 合併時回報的兩項（`common/encoding.ts:57` 註解、rtc-fake 的 SDP 補 `o=` 行） | GPT | T-114 | DOING |
| T-117 | T-105 第二輪審查遺留修正（T-105 未修完即合併）：**收看者第一次加入時要記住邀請碼與房間的對照**（現在每點一次邀請連結都會 `POST /join`，伺服器累積離線成員，10 分鐘內可能 `ROOM_FULL`，屬阻擋級）；長片名在 390px 撐寬版面；開播失敗後手動重試沒有送出請求 | Claude | T-105 | DONE |
| T-118 | 房主端接上傳輸層（房間層）：開播時建立傳輸並開始送畫面、換片時更新 track（replaceTrack）、踢人或收看者離線時 `removePeer`、直播中切模式（streaming.md §6「先停再開」）、開播前 60 Mbps 總上傳量提示；依 mode 分派 p2p／relay 的 dispatcher（relay 部分等 T-109） | Claude | T-107, T-110, T-115 | DOING |
| T-119 | T-110 審查後續（收看端）：實際停格（影格與接收量不再前進）時要回報 `buffering`，恢復後清除；收看分頁被 `4000` 取代後要清理該代傳輸、PC 與計時器；首個 snapshot 前到的信令要以新 socket 為單位暫存，等 snapshot 確認直播後再交付；停播後切模式時，新傳輸的建立時點對齊 §6（`room:updated` 時建立） | GPT | T-110 | DOING |

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
