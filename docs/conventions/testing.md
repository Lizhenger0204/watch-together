# 測試規範

## 必須有單元測試（Vitest）

| 模組 | 重點案例 |
| --- | --- |
| `signal/room` 邀請碼 | 字元集、長度、正規化（大小寫 / 連字號 / 空白）、碰撞重試 |
| `signal/room` 生命週期 | 鎖房、滿員、閒置計時、踢人後 token 失效、模式切換權限（用假時鐘） |
| `signal/signaling` 轉送規則 | 收看者只能送給房主、未驗證連線的訊息被拒、`peer:request` 觸發時機 |
| `shared` schema | 合法 / 非法訊息 |
| `web/features/source` | 解析度縮放計算、畫質預設對應的 encoding 參數、格式檢查的錯誤分類 |
| `web/features/transport` | ICE candidate 暫存、重連與 ICE restart 次數、總頻寬預估 |

WebRTC 相關邏輯要把 `RTCPeerConnection` 包在介面後面，單元測試用 fake 實作，不依賴真實瀏覽器。

## 整合測試

- signal：用 `@cloudflare/vitest-pool-workers`（在 Workers runtime 跑 Vitest）測 REST 與 WebSocket：建房 → 加入 → auth → snapshot → signal 轉送 → 踢人。
- 轉發模式的 Realtime API 呼叫用 mock，不在 CI 打真實 API。

## E2E（Playwright）

- 同一測試開 3 個 browser context：房主建房並選擇測試影片 → 2 位收看者用邀請碼加入 → 斷言兩位收看者的 `<video>` 都在播放（`currentTime` 持續前進、`videoWidth > 0`）。
- 測試影片放 `e2e/fixtures/`（H.264 + AAC mp4，≤ 1 MB，可 commit）。
- Chromium 參數：`--autoplay-policy=no-user-gesture-required` 只限測試使用，正式程式仍要處理自動播放政策。
- 只在 CI 跑 P2P 模式；轉發模式需要真實 Cloudflare 帳號，列入人工驗收。

## 人工驗收（T-113，做完後由使用者與朋友執行）

ADR 0002「待驗證清單」的實機項目：Windows Chrome / Edge 的 HEVC、mkv、背景分頁、3～7 人 P2P 負擔、中國大陸收看。結果記錄回 ADR 0002。

## 原則

- 測試不得依賴真實時間等待（不用 `sleep`），用假時鐘或事件等待。
- 修 bug 先寫重現測試。
- 不追求覆蓋率數字，但上表項目缺測試不得標記任務完成。
