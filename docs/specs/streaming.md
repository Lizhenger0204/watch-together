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

### 實作位置

- 編碼參數、codec 偏好：`features/transport/common/encoding.ts`（`applyVideoEncoding`、`applyAudioEncoding`、`applyCodecPreferences`、`preferredVideoCodecs`／`preferredAudioCodecs`）。
- 總頻寬預估：`features/transport/common/stats.ts`（`estimateTotalUploadBitrate`、`shouldWarnTotalUpload`）。
- 畫質預設實值：`packages/shared/src/quality.ts`（`QUALITY_PRESETS`）。

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
- 房主 WebSocket 重連（含重新整理、另一分頁取代）後，伺服器把直播改為未開播（protocol.md「房主重新連線」）。房主端關閉所有舊連線；若片源仍在，再送 `stream:status { live: true }`，依伺服器送來的 `peer:request` 對每位收看者重新建立。

### 實作注意事項（`features/transport/p2p/`，GPT）

以下都是踩過的坑（見 AGENTS.md「影片與 WebRTC」），GPT 實作 p2p/ 時照做，不要猜：

1. **codec 優先 H.264**：video 用 `common/encoding.ts` 的 `applyCodecPreferences()`（H.264 → VP8），音訊只送 Opus。收看端（尤其 Android）不一定能解 HEVC；房主端解碼後已重新編碼，所以送出要選 H.264。
2. **4K 要縮放**：`applyVideoEncoding()` 會設 `scaleResolutionDownBy = max(1, sourceHeight / targetHeight)`。4K 片源不設會以 4K 編碼，頻寬和 CPU 爆掉。
3. **`captureStream()` 只呼叫一次**：所有連線共用 `HostTransportOptions.stream`（同一個 `MediaStream`）；換片用 `replaceTrack`，不要重建連線。
4. **監聽 `addtrack`／`removetrack`**：影片播完時 Chrome 會把擷取的 track 從 stream 移除，重播是新的 track 物件。上層 `useLocalSource(onStreamChange)` 已把這件事包好；房主傳輸接到新 stream 時用 `replaceTrack(kind, track)` 換上，不能假設 track 物件永遠不變。
5. **ICE candidate 先暫存**：candidate 可能比 SDP 先到。在 `setRemoteDescription` 之前收到的 candidate 先放進佇列，remote description 設好後再 `addIceCandidate`。
6. **音訊不要開 `echoCancellation`／`noiseSuppression`／`autoGainControl`**：那是給麥克風用的，會修壞電影音效。captureStream 的軌道預設就是關的；`applyAudioEncoding()` 只設 maxBitrate，不要再動這三個。
7. **每次建連線前取 ICE**：`common/ice.ts` 的 `fetchIceServers(roomId, token)`（或注入的 `options.fetchIceServers`）。TURN 憑證短效，不要快取。
8. **`onPeerRequest` 觸發時**：若同一個 `memberId` 已有連線，先 `close()` 舊的再建新的（收看者重連或房主接手）。
9. **信令格式**：`SignalData`（`packages/shared`）的 `ice.candidate` 是 `IceCandidate`（`{ candidate, sdpMid, sdpMLineIndex, usernameFragment }`）。瀏覽器 `RTCPeerConnectionIceEvent.candidate` 是 `RTCIceCandidate`，送出前把它的 `candidate`／`sdpMid`／`sdpMLineIndex`／`usernameFragment` 複製成 `IceCandidate`；`candidate === null` 時送 `{ type: "ice", candidate: null }`（end-of-candidates）。
10. **統計**：每 2 秒用 `common/stats.ts` 的 `StatsSampler` 取碼率／RTT／遺失，透過 `onStats` 回報；收看者側由房間層送 `member:status`（傳輸層不直接送 `member:status`，它只有 signal 介面）。
11. **單元測試用 fake**：`RTCPeerConnection` 一律透過 `common/rtc.ts` 介面，測試用 `common/rtc-fake.ts` 的 `createFakePeerConnectionFactory()` 注入，不依賴真實瀏覽器（testing.md）。

## 4. 轉發模式（`features/transport/relay/` + `apps/signal/src/relay/`）

- 房主：`POST /api/rooms/:roomId/whip`，body 為 SDP offer（`Content-Type: application/sdp`），回應 `201` + SDP answer + `Location` header（資源 URL）。停止時 `DELETE` 該 `Location`。
- 收看者：`POST /api/rooms/:roomId/whep`，流程相同。
- apps/signal 負責呼叫 Cloudflare Realtime API 建立 session、發布或拉取 track，並把房主發布的 track 名稱存在 RoomDO。實作參考 Cloudflare 官方 `realtime-examples/whip-whep-server`，先確認其授權條款。
- 房主未開播時，收看者的 WHEP 請求回 `409 STREAM_NOT_LIVE`，收看者等待 `stream:status { live: true }` 再請求。
- WHIP / WHEP 請求一律帶 `Authorization: Bearer <token>`，並驗證角色（WHIP 只限房主）。
- 在 Realtime 開好 session 後，若 RoomDO 拒絕登記（例如房間剛好關閉），伺服器立刻關掉這些 tracks。關不掉時，交給 RoomDO 記成清理待辦，由 alarm 重試關閉（重試規則同 room-and-invite.md 的關房清理），不能丟著不管。

## 5. ICE 設定（`apps/signal/src/ice/`）

- `GET /api/rooms/:roomId/ice` 回傳 `{ iceServers }`，客戶端在**每次建立連線前**取得（TURN 憑證有時效）。前端用 `features/transport/common/ice.ts` 的 `fetchIceServers(roomId, token)`。
- STUN：`stun:stun.cloudflare.com:3478`，再加一個中國大陸可用的 STUN（候選如 `stun:stun.miwifi.com:3478`，上線前實測）。**不可只用 Google STUN**。
- TURN：Cloudflare TURN 短效憑證（TTL 4 小時），由伺服器用 API 產生，金鑰存在 Workers secrets，不可出現在前端程式碼。回傳前過濾掉 port 53 的位址（瀏覽器會擋）。
- 轉發模式同樣使用這份 ICE 設定。

## 6. 模式切換

- 只有房主可切換：`room:update { mode: 'p2p' | 'relay' }`。伺服器廣播 `room:updated`。
- **傳輸物件的 `mode` 是建立時固定的**：切換模式 = 拆掉舊傳輸、依新模式建立新傳輸，不是改欄位。切換由**房間層（hook）**協調，不是傳輸自己切；傳輸只負責建立、傳送、銷毀。

```
房間層收到 room:updated（mode 改變）
  房主  ：old.destroy() → createHostTransport({ mode: 新mode, stream: 同一個 captureStream, ... }) → start()
  收看者：old.destroy() → createViewerTransport({ mode: 新mode, ... })
          ├─ p2p   ：start()，等房主 offer（伺服器會對每位收看者再發 peer:request 給房主）
          └─ relay ：等 stream:status { live: true } 再 start()（送 WHEP）
```

- **stream 不重建**：房主換模式時沿用同一個 `captureStream()` 的 stream，只換傳輸物件。
- 事件順序：`room:updated` → 舊傳輸 `destroy()`（釋放 RTCPeerConnection 與監聽）→ 新傳輸建立並 `start()` → 房主若在直播中重新送 `stream:status { live: true }` → 收看者依新模式等 offer（P2P）或送 WHEP（轉發）。
- 預期中斷數秒，UI 顯示「切換中」。

### 房主重新連線（T-114）

- 房主 WebSocket 重連後重新 `auth`。伺服器會回 `room:snapshot`，並對每位在線收看者發 `peer:request`（順序見 protocol.md 與 T-114）。
- 房主傳輸收到一連串 `peer:request`：同一個 `memberId` 已有連線就先 `close()` 舊的、建新的（見 §3「失敗與重連」）。**stream 沿用同一個**，不重新 `captureStream()`。
- 房主重連後若仍在直播，由房間層再送 `stream:status { live: true }`（room-and-invite.md）。

## 7. 收看端播放（`features/player/`）

- `<video autoplay playsinline>`，`srcObject = remoteStream`。
- 瀏覽器的自動播放政策會擋有聲音的自動播放：進房顯示「點擊開始觀看」覆蓋層，點擊後才 `play()`。`play()` 被拒時恢復覆蓋層。
- 狀態提示：等待房主開播、連線中、播放中、緩衝中、連線失敗（提供「重新連線」按鈕）。
- 收看者沒有播放控制列，只有音量與全螢幕。

## 8. 連線統計

- 每 2 秒用 `getStats()` 取得碼率、封包遺失、RTT。前端用 `features/transport/common/stats.ts` 的 `StatsSampler` 取樣並算碼率（需上一次取樣做差）。
- 收看者每 5 秒送 `member:status { state, bitrateKbps, rttMs, packetLoss }`，伺服器只轉給房主，房主的成員列表顯示每人連線品質。`member:status` 由**房間層**送（傳輸層只暴露 `onState`／`onStats` 事件，沒有送 `member:status` 的介面）。

## 9. 傳輸層契約（`features/transport/`）

> 這節是定案契約，實作型別在 `features/transport/index.ts`（介面）與 `common/`（共用實作）。
> 分工：`index.ts` 介面、`common/`、`relay/` 歸 Claude；`p2p/` 歸 GPT。

### 兩個工廠

```ts
createHostTransport({ stream, signal, mode, quality, roomId, token }): HostTransport
createViewerTransport({ signal, mode, roomId, token }): ViewerTransport
```

- 兩者都可再注入：`fetchIceServers`（預設 `common/ice.ts` 的 `fetchIceServers(roomId, token)`）、`createPeerConnection`（預設瀏覽器原生，測試注入 fake）。
- `token` 是 `hostToken`／`memberToken`（機密，不可寫進 log）。
- 建立後**不會**自動開始，要呼叫 `start()`；`stop()` 停止但保留物件；`destroy()` 釋放所有連線、track 與監聽，之後不可再用。

### `signal`：傳輸層需要的最小介面（不依賴 lib/signal.ts）

```ts
interface TransportSignal {
  sendSignal(to: string, data: SignalData): void;
  onSignal(handler: (message: { from: string; data: SignalData }) => void): () => void;
  onPeerRequest(handler: (request: { memberId: string }) => void): () => void;
}
```

- `onPeerRequest` 只在房主端有用。T-115 不依賴 T-105；GPT 寫 p2p/ 可用 fake signal 測試。

### `HostTransport`（房主）回傳物件

| 成員 | 型別 | 說明 |
| --- | --- | --- |
| `mode` | `Mode` | 建立時固定，切換 = 重建 |
| `stream` | `MediaStream` | 送出的 captureStream（所有連線共用） |
| `start()` / `stop()` / `destroy()` | | 生命週期 |
| `replaceTrack(kind, track)` | | 換片／track 異動時換上（`replaceTrack`） |
| `setQuality(quality)` | | 播放中切畫質（`setParameters`） |
| `onState(handler)` | `HostTransportState = "idle" \| "live" \| "error"` | 整體狀態 |
| `onPeerState(handler)` | `{ memberId, state: MemberState }` | 每位收看者的連線狀態（P2P；relay 無逐人連線，不觸發） |
| `onStats(handler)` | `TransportStats & { memberId? }` | P2P 每 2 秒每位收看者；relay 回報單一上傳統計（無 memberId） |
| `onError(handler)` | `TransportError` | 錯誤，`memberId` 指出是哪位收看者 |

### `ViewerTransport`（收看者）回傳物件

| 成員 | 型別 | 說明 |
| --- | --- | --- |
| `mode` | `Mode` | 建立時固定 |
| `remoteStream` | `MediaStream` | `<video srcObject>` 用 |
| `start()` / `stop()` / `destroy()` | | 生命週期 |
| `onState(handler)` | `ViewerTransportState = MemberState`（`waiting`／`connecting`／`playing`／`buffering`／`failed`） | 直接對應收看者 UI 與 `member:status` |
| `onStats(handler)` | `TransportStats` | 每 2 秒 |
| `onError(handler)` | `TransportError` | 錯誤 |

### 共用型別

```ts
type TransportStats = { bitrateKbps: number; rttMs?: number; packetLoss?: number }; // packetLoss 0–1
type TransportErrorCode =
  | "ICE_UNAVAILABLE" | "SIGNAL_ERROR" | "PEER_FAILED" | "TRACK_ERROR" | "RELAY_FAILED";
class TransportError extends Error { code; message; memberId?; cause? }
```

### 生命週期與誰協調

- **傳輸層**只負責建立／傳送／統計／銷毀，不碰 React、不碰 `member:status`／`stream:status` 訊息。
- **房間層（hook）**負責：何時建立／銷毀傳輸（含模式切換、房主重連）、把 `onState`／`onStats` 轉成 `member:status`、送 `stream:status`、把 `TransportSignal` 接到真正的 SignalClient。

### `RTCPeerConnection` 介面與 fake

- 傳輸層一律透過 `common/rtc.ts` 的 `RtcPeerConnection`（及 `RtcRtpSender`／`RtcRtpTransceiver`）介面，不直接用原生 `RTCPeerConnection`。
- 單元測試用 `common/rtc-fake.ts` 的 `createFakePeerConnectionFactory()` 注入（testing.md），不依賴真實瀏覽器。
