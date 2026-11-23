# 規範：串流（選片、編碼、P2P、轉發）

## 1. 影片來源（房主端，`features/source/`）

### 支援格式

使用者約定片源統一為 **H.264 或 H.265（HEVC）影像 + AAC 音訊**。

| 容器 | 支援度 | 處理 |
| --- | --- | --- |
| mp4 / m4v / mov | 正式支援 | 直接播放 |
| mkv | Chrome / Edge 非正式支援，多數 H.264/HEVC + AAC 可播 | 允許選擇，但以下方檢查為準；失敗時提示改用 mp4 |
| 其他 | 不支援 | 檔案選擇器不列出 |

- HEVC 需要房主電腦有硬體解碼，Windows 上的 Chrome / Edge 才能播放。
- 檔案選擇器 `accept`：`video/mp4,video/quicktime,.mp4,.m4v,.mov,.mkv`。

### 開播前檢查（全部通過才允許開播）

1. 用 `URL.createObjectURL(file)` 載入到 `<video>`，等 `loadedmetadata`，逾時 10 秒視為失敗。
2. `videoWidth > 0 && videoHeight > 0`，否則提示「影像無法解碼（可能是 HEVC 不支援或容器不支援）」。
3. 試播 1 秒（靜音），確認 `captureStream()` 取得 1 條 video track，且至少 1 條 audio track；沒有音軌時提示「音訊無法解碼」，讓房主選擇是否繼續。
4. 檢查結束後回到 0 秒、暫停，取消靜音。

### 本地播放與擷取

- 房主端用**自訂控制列**操作本地 `<video>`（播放、暫停、拖進度、音量）。收看者看到的是擷取後的畫面，不需要額外同步。
- `const stream = video.captureStream()`，只呼叫一次，同一個 stream 給所有傳輸共用；換片時要重新擷取並替換所有連線的 track（`RTCRtpSender.replaceTrack`）。
- 房主端音量：T-106 在 Chrome 158（macOS）實測，`video.volume = 0` 與 `video.muted = true` 都**不影響**擷取出去的音訊（AnalyserNode RMS 幾乎相同），因此房主本地音量直接調 `video.volume`。Windows Edge 列入 T-113 驗收。
- **影片播完時 Chrome 會把擷取的 track 從 stream 移除**；房主再按播放或拖回前面時會加入新的 track。傳輸層必須監聽 `useLocalSource(onStreamChange)`（對應 stream 的 `addtrack` / `removetrack`），用 `replaceTrack` 換上新 track，不能假設 track 物件永遠不變。
- 房主關閉或重新整理分頁 = 停止直播。分頁在背景時要能繼續推流（實測項目）。

## 2. 編碼與畫質（`features/transport/common/`）

### 畫質預設

| 預設 | 目標高度 | maxBitrate | maxFramerate |
| --- | --- | --- | --- |
| 流暢 | 720 | 3 Mbps | 30 |
| 標準（預設） | 1080 | 6 Mbps | 30 |
| 高畫質 | 1080 | 8 Mbps | 30 |

- 房主在房間內選擇預設，可在播放中切換（呼叫 `setParameters`，不重建連線）。
- **4K 片源要縮放**：`scaleResolutionDownBy = max(1, videoHeight / 目標高度)`，否則會以 4K 編碼。
- `videoTrack.contentHint = 'motion'`；`degradationPreference = 'maintain-framerate'`。
- Codec 偏好：**H.264 優先**（收看端 Android 硬體解碼最普遍），其次 VP8。用 `RTCRtpTransceiver.setCodecPreferences` 設定。
- 音訊：Opus，`maxBitrate` 128 kbps，關閉 `echoCancellation` / `noiseSuppression` / `autoGainControl`（這些是給麥克風用的）。

### P2P 總頻寬保護

- 一般 3 位收看者，上限 7 位。
- 開播前顯示預估總上傳量 = 預設碼率 × 收看人數；超過 60 Mbps 時提示房主改用「流暢」或「轉發」模式，但不強制。

## 3. P2P 模式（`features/transport/p2p/`）

### 拓撲

房主與每位收看者各一條 `RTCPeerConnection`（mesh）。收看者之間不連線。

### 建立流程（房主主動發起）

1. 伺服器在收看者上線（或房主開播）時，送 `peer:request { memberId }` 給房主。
2. 房主 `addTransceiver(track, { direction: 'sendonly' })` 加入 video、audio，設定 codec 偏好與碼率，`createOffer` → `setLocalDescription` → `signal { to, data: { type: 'offer', sdp } }`。
3. 收看者 `setRemoteDescription` → `createAnswer` → 回 `signal { type: 'answer' }`。
4. 雙方 trickle ICE：`signal { type: 'ice', candidate }`。在 remote description 設定前收到的 candidate 要先暫存。
5. 成功後收看者送 `member:status { state: 'playing' }`。

### 失敗與重連

- `iceConnectionState` 變成 `disconnected` 超過 5 秒，或變成 `failed`：房主執行 ICE restart（`createOffer({ iceRestart: true })`），最多 3 次；仍失敗就關閉連線，回報 `member:status { state: 'failed' }`。
- 收看者 WebSocket 重連後重新驗證，伺服器再發一次 `peer:request` 給房主，房主關閉舊連線、建立新連線。
- 房主 WebSocket 重連後，關閉所有舊連線，對所有在線收看者重新建立。

## 4. 轉發模式（`features/transport/relay/` + `apps/signal/src/relay/`）

- 房主：`POST /api/rooms/:roomId/whip`，body 為 SDP offer（`Content-Type: application/sdp`），回應 `201` + SDP answer + `Location` header（資源 URL）。停止時 `DELETE` 該 `Location`。
- 收看者：`POST /api/rooms/:roomId/whep`，流程相同。
- apps/signal 負責呼叫 Cloudflare Realtime API 建立 session、發布或拉取 track，並把房主發布的 track 名稱存在 RoomDO。實作參考 Cloudflare 官方 `realtime-examples/whip-whep-server`，先確認其授權條款。
- 房主未開播時，收看者的 WHEP 請求回 `409 STREAM_NOT_LIVE`，收看者等待 `stream:status { live: true }` 再請求。
- WHIP / WHEP 請求一律帶 `Authorization: Bearer <token>`，並驗證角色（WHIP 只限房主）。

## 5. ICE 設定（`apps/signal/src/ice/`）

- `GET /api/ice` 回傳 `{ iceServers }`，客戶端在**每次建立連線前**取得（TURN 憑證有時效）。
- STUN：`stun:stun.cloudflare.com:3478`，再加一個中國大陸可用的 STUN（候選如 `stun:stun.miwifi.com:3478`，上線前實測）。**不可只用 Google STUN**。
- TURN：Cloudflare TURN 短效憑證（TTL 4 小時），由伺服器用 API 產生，金鑰存在 Workers secrets，不可出現在前端程式碼。
- 轉發模式同樣使用這份 ICE 設定。

## 6. 模式切換

- 只有房主可切換：`room:update { mode: 'p2p' | 'relay' }`。
- 伺服器廣播 `room:updated`。房主關閉舊傳輸、依新模式重建；收看者關閉舊連線，P2P 等房主的 offer，轉發則在 `stream:status.live` 為真時送 WHEP。
- 預期中斷數秒，UI 顯示「切換中」。

## 7. 收看端播放（`features/player/`）

- `<video autoplay playsinline>`，`srcObject = remoteStream`。
- 瀏覽器的自動播放政策會擋有聲音的自動播放：進房顯示「點擊開始觀看」覆蓋層，點擊後才 `play()`。`play()` 被拒時恢復覆蓋層。
- 狀態提示：等待房主開播、連線中、播放中、緩衝中、連線失敗（提供「重新連線」按鈕）。
- 收看者沒有播放控制列，只有音量與全螢幕。

## 8. 連線統計

- 每 2 秒用 `getStats()` 取得碼率、封包遺失、RTT。
- 收看者每 5 秒送 `member:status { state, bitrateKbps, rttMs, packetLoss }`，伺服器只轉給房主，房主的成員列表顯示每人連線品質。
