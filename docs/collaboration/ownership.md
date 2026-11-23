# 分工：Claude 與 GPT

## 分工原則

- **Claude**：跨模組契約、有狀態與時序的邏輯（房間、信令、WebRTC 傳輸）、頁面 UI、規範文件、Code review。
- **GPT（Codex）**：規格明確、以實作量為主的模組（工具鏈、部署、選片、轉發轉接、ICE）。
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
| WebRTC 傳輸 | `apps/web/src/features/transport/` | Claude | 唯讀 |
| 選片與擷取 | `apps/web/src/features/source/` | GPT | 唯讀 |
| 前端頁面與 UI | `apps/web/src/pages/`、`features/room/`、`features/player/`、`lib/`、共用 UI 元件 | Claude | 唯讀；`features/source/` 的 UI 元件由 GPT 做，Claude 負責擺進頁面 |
| E2E | `e2e/` | GPT | Claude 可新增傳輸相關案例，需 review |
| Scaffold、工具鏈、CI、部署 | 根目錄設定檔、`.github/`、`wrangler.toml`、部署文件 | GPT | 唯讀 |
| 協作文件 | `docs/collaboration/` | 協調者（GPT 監工），只在 `main` 上改 | agent 在分支中不改；需求寫在 commit 訊息或回報 |

### 模組之間的介面（由 Claude 提出，變動需雙方確認）

- `features/source` 匯出 `useLocalSource()`：選檔、檢查結果、`<video>` ref、`MediaStream`。
- `features/transport` 匯出 `createHostTransport({ stream, signal, mode, quality })` 與 `createViewerTransport({ signal, mode })`；後者提供 `remoteStream` 與狀態事件。
- `features/player` 只消費 `remoteStream` 與狀態，不直接碰 WebRTC。

## 對話角色

| 對話 | 角色 | 工作位置 |
| --- | --- | --- |
| **GPT 監工**（Claude，獨立對話） | **唯一的協調者**：派 GPT 子對話、審查 GPT 分支、派 GPT 審查 Claude 分支、合併到 `main`、更新 `tasks.md` | 主目錄 `main` |
| **Claude 實作**（Claude，主對話） | 做看板上負責人為 Claude 的任務；維護規範文件（隨自己的分支提交） | `../project-claude` worktree，分支 `claude/*` |
| **GPT 子對話**（Codex，由監工開） | 做負責人為 GPT 的任務，或審查 Claude 的分支 | 各自的 worktree，分支 `gpt/*` |

- 只有監工可以 commit 到 `main`。Claude 實作對話與 GPT 子對話都不直接改 `main`。
- 兩個 Claude 對話不會自動互通：Claude 實作做完分支後由使用者告知監工；監工合併後，Claude 實作開新任務前先 `git rebase main`。
- 監工派工時把任務改為 `DOING`；Claude 實作要開始自己的任務前，先確認看板上已是 `DOING`（或請使用者轉告監工）。

## 交叉 Review

- GPT 的變更由 Claude review：重點看是否符合 spec、安全（token、secrets、權限檢查）。
- Claude 的變更由 GPT review：重點看可讀性、測試是否涵蓋、能否在其 UI 中直接使用。
- review 意見回報給協調者，由協調者記到 tasks.md 該任務的交接備註。

## 卡住時

1. 缺 spec：回報協調者新增 `SPEC` 類任務指派給 Claude，自己先做不受影響的部分。
2. 需要對方區塊的改動：回報協調者開任務指派對方，寫清楚需要的函式簽名或訊息。
3. 意見不同：兩種方案寫進 `docs/decisions/` 草稿 ADR，交給使用者決定。

> 分工可由使用者調整，改這張表即可。
