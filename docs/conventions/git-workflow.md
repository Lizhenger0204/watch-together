# Git 流程

## 分支

- `main`：永遠可建置、測試全綠。不直接在 `main` 上開發。
- 分支名：`<agent>/<任務編號>-<簡述>`，例如 `claude/T-107-p2p-transport`、`gpt/T-106-source`。

## 工作目錄隔離（worktree）

### 何時用

| 情況 | 做法 |
| --- | --- |
| 只有一個 agent 在工作 | 直接在主目錄的分支上做，不開 worktree |
| 阻塞型任務（其他任務都在等它，例如 T-101 scaffold） | 單獨在主目錄做，完成合併後才開放平行 |
| 兩個 agent 同時開工 | **各自一個 worktree + 分支**，不共用工作目錄 |

```bash
git worktree add ../project-claude -b claude/T-103-room-core
git worktree add ../project-gpt    -b gpt/T-105-pages
```

### 開 worktree 前

- **先把要用的東西 commit 到 `main`**。worktree 從 commit 建立，未 commit 的檔案（包括 `docs/` 規範）不會出現在新的 worktree 裡。
- 每個 worktree 都要各自 `pnpm install`（pnpm 共用全域 store，不會重複下載）。
- 每個 worktree 的 `data/` 是獨立的，上傳的測試影片不會共用。

### 同時跑 `pnpm dev`

兩個 worktree 預設會搶同樣的 port。用環境變數錯開（見 development.md）：

| worktree | `SIGNAL_PORT`（signal） | `WEB_PORT`（web） |
| --- | --- | --- |
| claude | 8787 | 5173 |
| gpt | 8887 | 5273 |

### 結束後

合併完成後移除：`git worktree remove ../project-gpt`，再刪除已合併的分支。

## Commit

- Conventional Commits：`feat(server): ...`、`fix(web): ...`、`docs(specs): ...`、`test(sync): ...`、`chore: ...`。
- scope 用目錄名：`web`、`server`、`shared`、`e2e`、`specs`、`collab`。
- 一個 commit 一件事；改契約（`docs/specs` + `packages/shared`）盡量獨立成一個 commit，方便對方 rebase。

## 合併

- **合併到 `main` 由協調者（使用者或 Claude 主對話）執行**。agent 只在自己的分支 commit，不自行合併。
- 交接備註寫在分支最後一個 commit 的訊息內文（格式見 tasks.md），不要在分支裡改 `tasks.md`。

步驟：

1. 合併前 rebase 到最新 `main`，跑 `pnpm typecheck && pnpm lint && pnpm test`。
2. 動到 `packages/shared` 或 `docs/specs` 的變更，需另一個 agent（或使用者）review 過。
3. **契約變更優先合併**：含 `packages/shared` 的分支先合進 `main`，另一個 agent 再 rebase，之後才合併它的分支。
4. 用 fast-forward 或 squash 合併，保持 `main` 線性。
5. 合併後由協調者在 `main` 上更新 `docs/collaboration/tasks.md`。

## 禁止

- force push `main`、改寫已合併的歷史。
- commit `.env`、`.dev.vars`、任何金鑰、影片檔（測試 fixture 除外，≤ 1 MB）。
