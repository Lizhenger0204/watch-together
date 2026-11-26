# BUG 清單

> 記錄實測發現的缺陷與行為落差。若修正涉及規格／協定變更，依協作鐵律先更新 `docs/specs/` 與 `packages/shared`，再進實作與補回歸測試。
> 對應看板任務見 [tasks.md](tasks.md)。

## 總覽

| 編號 | 摘要 | 發現時機 | 對應任務 | 狀態 |
| --- | --- | --- | --- | --- |
| BUG-001 | 房主關掉瀏覽器之後，不會自動退出房間 | 人工實測（GPT 測試期間未顯現） | T-132 | FIXED（已合進 main，待部署實測） |
| BUG-002 | 退出房間之後，房間若沒人不會自動釋出空房間 | 人工實測（GPT 測試期間未顯現） | T-134 | FIXED（已合進 main，待部署實測） |
| BUG-003 | 無法播放 HEVC（H.265）影片 | 人工實測（GPT 測試期間未顯現） | T-133 | OPEN（試播與診斷修正已合進 main，待原始片源複驗） |

---

## BUG-001：房主關掉瀏覽器之後，不會自動退出房間

- **狀態**：FIXED（已合進 `main` `64d7e2d`..`00b6d73`，待部署實測）
- **發現來源**：使用者實測回報（GPT 測試期間並未顯現）
- **現象**：房主直接關掉瀏覽器後，不會自動退出房間；重新開啟仍保留房主身份，房間與房主席位也不會因此結束。
- **修正前的行為與可能成因**：
  1. 現行規格（`docs/specs/room-and-invite.md`）採「房主斷線不轉移、房間繼續存在」，且憑證寫在 `localStorage`（`room:<roomId>:token`），關閉瀏覽器後不會清除。
  2. 伺服器端 `onDisconnect()`（`apps/signal/src/signaling/process.ts`）在房主斷線時僅更新 `lastSeenAt` 並將直播狀態改為未開播，沒有自動退房或關房流程；`RoomDO`（`apps/signal/src/runtime/workers/room-do.ts`）目前尚未開放 `host_closed` 的主動關房路徑。
  3. 前端「離開房間」（`apps/web/src/pages/RoomPage.tsx`）僅撤銷本分頁開播意圖並導回首頁，未通知伺服器退出房間或移除身份。
  4. 伺服器端目前未對 WebSocket 心跳逾時做主動清理；若直接關閉瀏覽器時未送出 close frame，伺服器甚至可能不會即時察覺房主已離線。
- **為何 GPT 測試期間未顯現**：
  - 現有單元測試與 E2E（`apps/signal/test/`、`e2e/`）皆依原 spec 驗證「斷線後保留身份並重連恢復」，未涵蓋「關閉真實瀏覽器後自動退房」的驗收案例。

---

## BUG-002：退出房間之後，房間若沒人不會自動釋出空房間

- **狀態**：FIXED（已合進 `main` `37d8bfd`..`fc2151d`，待部署實測）
- **發現來源**：使用者實測回報（GPT 測試期間並未顯現）
- **現象**：成員（含房主）退出房間後，即使房間內已經沒有人，空房間不會自動釋出。
- **修正前的行為與可能成因**：
  1. 現行生命週期設定（`apps/signal/src/config.ts`、`apps/signal/wrangler.toml`）在最後一人離線後會等待 **30 分鐘**（`ROOM_IDLE_TTL_MS = 1800000`）才觸發 `RoomDO.alarm()` 關房並釋放邀請碼，而非無人時即時釋出。
  2. 前端點「離開房間」（`apps/web/src/pages/RoomPage.tsx`）只是前端 `navigate("/")` 斷開 WebSocket，伺服器無法區分「主動退房」與「暫時斷線／重新整理」，因此不會移除成員席位或立刻關閉空房。
  3. 若疊加 BUG-001（瀏覽器直接關閉導致 WebSocket 未觸發 `webSocketClose`），`onlineAfter.size` 不會歸零、`idleSince` 不會啟動，空房間會一路留到 24 小時上限（`ROOM_MAX_AGE_MS`）。
- **為何 GPT 測試期間未顯現**：
  - 既有測試（如 `apps/signal/test/room.test.ts`）只驗證 `closeAt` 等於 `idleSince + 30 分鐘`，E2E 也未驗證「所有人退出房間後，空房間與邀請碼是否立即釋出」。

---

## BUG-003：無法播放 HEVC（H.265）影片

- **狀態**：OPEN（試播與診斷修正已合進 `main`，待原始片源複驗）
- **已驗證**：四種 HEVC 樣本在 macOS Chrome 158 均能解碼、擷取並播放。停用原生 HEVC 解碼時會顯示失敗診斷。
- **發現來源**：使用者實測回報（GPT 測試期間並未顯現）
- **現象**：房主選取 HEVC（H.265）影片後無法正常播放（檢查失敗或無法解碼）。
- **修正前的行為與可能成因**：
  1. 房主端片源檢查（`apps/web/src/features/source/use-local-source.ts`、`browser-source.ts`）直接以 `<video src={objectURL}>` 載入，再呼叫 `captureStream()` 與靜音試播 1 秒（`probePlayback`）；若 `loadedmetadata` 觸發 `error`、`videoWidth <= 0`、`play()` 拒絕或 `captureStream()` 取不到恰好 1 條 video track，一律歸類為 `VIDEO_UNDECODABLE`。
  2. 瀏覽器對 HEVC 原生播放有嚴格限制：Windows Chrome／Edge 需系統硬體解碼與 HEVC 延伸模組；此外 `.mkv` 容器封裝、`hev1`（非 `hvc1`）codec tag、或 10-bit（Main 10 / HDR）HEVC 在部分平台與 Chrome 版本常無法透過 `<video>` 直接解碼，或出現有聲無影（`videoWidth === 0`）。
  3. 現行錯誤處理會把實際的 `video.error`（code / message）與失敗階段統一吞成單一 `VIDEO_UNDECODABLE`，缺乏診斷資訊以分辨是作業系統／瀏覽器環境不支援、容器封裝問題（如 MKV / `hev1`），還是 `captureStream()` 試播流程本身出錯。
- **為何 GPT 測試期間未顯現**：
  - `e2e/source.spec.ts`（第 81–108 行）雖然有載入 `e2e/fixtures/hevc-aac.mp4`，但斷言寫成 `/檢查通過|影像無法解碼/`，**就算 HEVC 完全無法解碼也會直接判 PASS**；且 fixture 僅有單一簡單 mp4 樣本，未涵蓋實測常見的 HEVC 容器／位元深度（10-bit、MKV、`hev1`）與不同平台解碼環境。

---

## 修正前待確認（契約先行）

在修改實作前，需先確認預期規格並更新 `docs/specs/room-and-invite.md`、`docs/specs/protocol.md` 與 `docs/specs/streaming.md`：

1. **關閉瀏覽器 vs. 重新整理（BUG-001）**：房主單純按 F5 重新整理是否仍需保留房主身份，或是改用 `sessionStorage`／短寬限期（搭配心跳／`pagehide`）區分「重整」與「關閉瀏覽器」？
2. **主動退出房間語意（BUG-001／BUG-002）**：點「離開房間」是否應送出明確退房請求、移除席位並清除憑證？房主退出時是要關閉整個房間（`host_closed`），還是僅在房內無人時釋出？
3. **空房間釋出時機（BUG-002）**：全員退出／離線後是要立即釋出，還是設定較短的空房緩衝時間（例如數十秒內無人回房即關房並釋放邀請碼）？
4. **HEVC 播放排查與支援策略（BUG-003）**：需先確認實測失敗的環境（作業系統、瀏覽器版本）與片源格式（`.mp4` / `.mkv`、8-bit / 10-bit、`hvc1` / `hev1`、實際失敗訊息），再決定修正方向（例如補齊失敗階段與解碼能力診斷、支援 MKV／`hev1` 解封裝或 WebCodecs 方案，或調整開播前檢查流程）。
