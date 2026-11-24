# AGENTS.md — 遠端同步播放器

> 本檔只放**指路牌**與**避坑指南**。具體規範一律寫在 `docs/`，不要把細則塞回這裡。
> 適用對象：Claude（Claude Code）與 GPT（Codex）。`CLAUDE.md` 只是引用本檔。

## 一句話說明專案

房主在瀏覽器選本機電影（H.264 / H.265 + AAC）直接播放 → 網頁用 WebRTC 即時送給收看者（房主可切換「P2P 直連」或「轉發：經 Cloudflare Realtime」）→ 房主把**邀請碼**給朋友 → 同房間的人即時觀看。不上傳檔案、伺服器不轉碼。

## 溝通

- **一律用繁體中文回覆使用者**（回報、交接備註、commit 說明、審查意見都是）。程式碼、識別字、指令與錯誤原文照原樣保留。

## 指路牌（開工前先讀對應文件）

| 你要做的事 | 先讀這份 |
| --- | --- |
| 了解整體架構、目錄、資料流 | [docs/architecture.md](docs/architecture.md) |
| 為什麼是這個架構（目前有效的決定） | [docs/decisions/0002-browser-live-streaming.md](docs/decisions/0002-browser-live-streaming.md) |
| 最初的技術選型（部分已被取代） | [docs/decisions/0001-tech-stack.md](docs/decisions/0001-tech-stack.md) |
| 房間、邀請碼、角色、生命週期 | [docs/specs/room-and-invite.md](docs/specs/room-and-invite.md) |
| 選片、編碼畫質、P2P、轉發、ICE、模式切換 | [docs/specs/streaming.md](docs/specs/streaming.md) |
| REST 與 WebSocket 訊息格式 | [docs/specs/protocol.md](docs/specs/protocol.md) |
| 程式風格、命名、錯誤處理 | [docs/conventions/code-style.md](docs/conventions/code-style.md) |
| 安裝、啟動、指令、變數與 secrets | [docs/conventions/development.md](docs/conventions/development.md) |
| 測試要求 | [docs/conventions/testing.md](docs/conventions/testing.md) |
| Git 分支、worktree、commit、合併 | [docs/conventions/git-workflow.md](docs/conventions/git-workflow.md) |
| **Claude / GPT 誰負責哪一塊** | [docs/collaboration/ownership.md](docs/collaboration/ownership.md) |
| 任務看板、派工、交接 | [docs/collaboration/tasks.md](docs/collaboration/tasks.md) |

## 協作鐵律（三條，其餘看 ownership.md）

1. **只改自己負責的目錄**。要動別人的區塊，回報協調者開任務交給對方，或寫在交接備註裡。
2. **契約先行**：改 API／訊息／共用型別，先改 `docs/specs/protocol.md` 和 `packages/shared`，再改實作；兩邊不一致時以 spec 為準。
3. **完成任務前**：`pnpm typecheck && pnpm lint && pnpm test` 全綠，並把交接備註（格式見 tasks.md）寫在最後一個 commit 的訊息內文。

## 避坑指南

### 協作
- **兩個 agent 不要在同一個工作目錄同時動工**。各自用自己的 git worktree／分支（`claude/*`、`gpt/*`），見 git-workflow.md。
- **開 worktree 前先 commit**。worktree 從 commit 建立，未 commit 的規範文件不會出現在裡面。
- **只有「GPT 監工」對話能改 `main`**（合併、更新 `tasks.md`）。其他 agent 不要在分支裡改 `tasks.md`，也不要自行合併。交接備註寫在 commit 訊息。→ ownership.md「對話角色」
- **同時跑兩個 `pnpm dev` 會搶 port**，用 `WEB_PORT`／`SIGNAL_PORT` 錯開。
- **不要各自定義一份 type**。前後端共用的型別、訊息、zod schema 只能放 `packages/shared`。
- **不要繞過 pnpm 的新版本冷卻期**（`minimumReleaseAge`）。被擋就改選較舊的版本，不要加 `minimumReleaseAgeExclude`。裝套件前也要確認它沒有被標成 deprecated。
- **Codex 讀 `AGENTS.md`，Claude Code 讀 `CLAUDE.md`**。規範改在 `docs/`，不要只改其中一個入口檔。
- 發現 spec 有漏洞或矛盾：**先停下來回報**（由 Claude 改 spec、協調者記到 tasks.md），不要自己腦補一個實作。

### 影片與 WebRTC
- **房主只能用桌面 Chrome／Edge**。Safari 沒有 `HTMLMediaElement.captureStream()`。收看者用什麼瀏覽器都可以。
- **4K 片源一定要設 `scaleResolutionDownBy`**，否則會以 4K 編碼，頻寬和 CPU 都爆掉。→ streaming.md §2
- **`captureStream()` 只呼叫一次**，所有連線共用同一個 stream；換片用 `replaceTrack`，不要重建連線。
- **影片播完時 Chrome 會移除擷取的 track**，重播後是新的 track 物件。傳輸層要監聽 `addtrack`／`removetrack` 再 `replaceTrack`。→ streaming.md §1
- **Playwright 內建的 Chromium 不支援 H.264／AAC**。播放真實影片的 E2E 要用 `channel: 'chrome'`（需安裝 Google Chrome）。
- **送出 codec 優先 H.264**。收看端（尤其 Android）不一定能解 HEVC；房主端解碼後會重新編碼。
- **音訊要關掉 echoCancellation／noiseSuppression／autoGainControl**，那是給麥克風用的，會把電影音效修壞。
- **ICE candidate 可能比 SDP 先到**，remote description 設好之前要先暫存。
- **不可只用 Google STUN**，中國大陸連不到。TURN 憑證是短效的，每次建連線前重新取得。→ streaming.md §5
- **自動播放政策**：收看端沒有使用者點擊，就不能播放有聲音的影片。進房一律先顯示「點擊開始觀看」。

### Cloudflare Workers
- **瀏覽器的 WebSocket 不能帶自訂 header**。token 用連線後第一則 `auth` 訊息傳，**不可放在 URL query**。
- **Durable Object 會休眠**，記憶體裡的變數可能消失。需要保留的狀態寫進 DO storage，計時用 alarm，不要用 `setTimeout`。
- `room/`、`signaling/`、`relay/`、`ice/` **不可直接用 Workers 專屬 API**，只透過 `runtime/` 介面，保留搬到香港主機的退路。→ architecture.md
- **邀請碼對照不要用 KV**（最終一致，重新產生後舊碼可能還能用），用 `InviteDirectoryDO`。

### 安全
- **邀請碼要能抵抗暴力猜測**：限流、錯誤一律回同一種訊息、可由房主重新產生。→ room-and-invite.md
- `hostToken`／`memberToken`、Realtime 與 TURN 金鑰是機密，**不可寫進 log、URL、錯誤訊息或前端程式碼**。金鑰只放 Workers secrets／`.dev.vars`。
- 開播、切換模式、踢人、WHIP 都要**在伺服器端檢查角色**，不能只靠前端隱藏按鈕。
- 收看者的 `signal` 只能送給房主，伺服器必須擋下送給其他收看者的訊息。
