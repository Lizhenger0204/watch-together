# 分工：Claude 與 GPT

## 分工原則

- **Claude**：跨模組契約、有狀態與時序的邏輯（房間、信令、傳輸層共用架構與轉發客戶端）、頁面 UI、規範文件、Code review。
- **GPT（Codex）**：規格明確、以實作量為主的模組（工具鏈、部署、選片、轉發轉接、ICE、P2P 傳輸）。
- 依「目錄」切分，讓兩邊幾乎不會改到同一個檔案。

## 目錄負責表

| 區塊 | 路徑 | 負責 | 另一方可以 |
| --- | --- | --- | --- |
| 規範文件 | `docs/specs/`、`docs/conventions/`、`docs/decisions/`、`docs/architecture.md` | Claude | 提議修改，回報協調者 |
| 共用契約 | `packages/shared/` | Claude | 依已更新的 spec 增加欄位，需 review |
| 房間核心 | `apps/signal/src/room/` | Claude | 唯讀 |
| 信令 | `apps/signal/src/signaling/` | Claude | 唯讀 |
| Workers runtime（DO） | `apps/signal/src/runtime/` | Claude | 新增轉發相關儲存欄位時可改，需 review |
| Hono routes | `apps/signal/src/app.ts` | Claude | 新增 relay / ice route 可改，需 review |
| 轉發轉接 | `apps/signal/src/relay/` | GPT | 唯讀 |
| ICE / TURN | `apps/signal/src/ice/` | GPT | 唯讀 |
| 傳輸層介面與共用架構 | `apps/web/src/features/transport/`（`index.ts` 介面、`common/`）、`features/transport/relay/` | Claude | 唯讀；介面變動需雙方確認 |
| P2P 傳輸 | `apps/web/src/features/transport/p2p/` | GPT | 唯讀 |
| 選片與擷取 | `apps/web/src/features/source/` | GPT | 唯讀 |
| 前端頁面與 UI | `apps/web/src/pages/`、`features/room/`、`features/player/`、`lib/`、共用 UI 元件 | Claude | 唯讀；`features/source/` 的 UI 元件由 GPT 做，Claude 負責擺進頁面 |
| E2E | `e2e/` | GPT | Claude 可新增傳輸相關案例，需 review |
| Scaffold、工具鏈、CI、部署 | 根目錄設定檔、`.github/`、`wrangler.toml`、部署文件 | GPT | 唯讀 |
| 協作文件 | `docs/collaboration/` | 協調者（主對話），只在 `main` 上改 | agent 在分支中不改；需求寫在 commit 訊息或回報 |

### 模組之間的介面（由 Claude 提出，變動需雙方確認）

- `features/source` 匯出 `useLocalSource()`：選檔、檢查結果、`<video>` ref、`MediaStream`。
- `features/transport` 匯出 `createHostTransport({ stream, signal, mode, quality })` 與 `createViewerTransport({ signal, mode })`；後者提供 `remoteStream` 與狀態事件。確切的型別、狀態事件與模式切換流程由 T-115 定案並寫進 streaming.md；`p2p/`（GPT）與 `relay/`（Claude）都照這份介面實作，不可各自擴充。
- `features/player` 只消費 `remoteStream` 與狀態，不直接碰 WebRTC。

## 對話角色

| 對話 | 角色 | 工作位置 |
| --- | --- | --- |
| **主對話**（Claude，使用者直接對話的那一個） | **協調者**：派子對話、送審、依審查結果或使用者指示合併到 `main`、更新 `docs/collaboration/`；也做負責人為 Claude 的任務、維護規範文件 | 主目錄 `main`；自己的實作另開 worktree，分支 `claude/*` |
| **實作子對話**（Claude 或 Gemini，由主對話或使用者開） | 做看板上指派給它的任務 | 各自的 worktree，分支 `claude/*`、`gemini/*` |
| **GPT 子對話**（Codex，由主對話或使用者開） | 做負責人為 GPT 的任務、code review、測試 | 各自的 worktree，分支 `gpt/*` |

- 沒有專門的監工對話。協調者就是主對話；使用者也可以明確指定其他對話做某次合併或更新看板。
- 只有協調者可以 commit 到 `main`。子對話只在自己的分支 commit，不直接改 `main`、不自行合併。
- 對話之間不會自動互通：子對話做完分支後，由使用者告知主對話（或由主對話派出的子任務直接回報）；合併後，其他分支開新任務前先 `git rebase main`。
- 協調者派工時把任務改為 `DOING`；子對話開始前先確認看板上已是 `DOING`（或請使用者轉告主對話）。

## 交叉 Review

- GPT 的變更由 Claude review：重點看是否符合 spec、安全（token、secrets、權限檢查）。
- Claude 的變更由 GPT review：重點看可讀性、測試是否涵蓋、能否在其 UI 中直接使用。
- review 意見回報給協調者，由協調者記到 tasks.md 該任務的交接備註。

## 卡住時

1. 缺 spec：回報協調者新增 `SPEC` 類任務指派給 Claude，自己先做不受影響的部分。
2. 需要對方區塊的改動：回報協調者開任務指派對方，寫清楚需要的函式簽名或訊息。
3. 意見不同：兩種方案寫進 `docs/decisions/` 草稿 ADR，交給使用者決定。

> 分工可由使用者調整，改這張表即可。
