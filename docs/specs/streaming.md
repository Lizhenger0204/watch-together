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
2. 房主 `addTransceiver(track, { direction: 'sendonly' })` 加入 video、audio，用
   `applyCodecPreferences(transceiver, capabilities)` 設定 codec 偏好、
   `applyVideoEncoding`／`applyAudioEncoding` 設定碼率與縮放，然後
   `createOffer()` → `setLocalDescription(offer)` →
   `signal { to, data: { type: 'offer', sdp } }`。
3. 收看者 `setRemoteDescription(offer)` → `createAnswer()` →
   **`setLocalDescription(answer)` 之後才送出** → `signal { type: 'answer', sdp }`。
4. 房主收到 answer 後 `setRemoteDescription(answer)`。
5. 雙方 trickle ICE：`signal { type: 'ice', candidate }`。**candidate 可能比 SDP 先到**，
   在 remote description 設好之前先放進**依成員、依當次協商分開**的佇列，remote
   description 設好後才依序 `addIceCandidate`。adapter（`common/rtc.ts`）已把
   `RTCIceCandidate` 正規化成 `{ candidate: string, ... }`（candidate 非空），
   `candidate === null` 代表 end-of-candidates。
6. 成功後收看者送 `member:status { state: 'playing' }`。

### 失敗與重連

- `iceConnectionState` 變成 `disconnected` 超過 5 秒，或變成 `failed`：房主執行
  ICE restart（`createOffer({ iceRestart: true })`）。**每次「斷線事件」最多 3 次**，
  3 次仍失敗就關閉連線、回報 `member:status { state: 'failed' }`，並呼叫
  `removePeer(memberId)` 清掉這條連線。
- **等不到 answer 的期限**：收到 `peer:request` 後 15 秒內沒收到該收看者的 answer，
  視為失敗，走 `PEER_FAILED` + `removePeer(memberId)`。
- 收看者 WebSocket 重連後重新驗證，伺服器再發一次 `peer:request` 給房主，房主
  關閉舊連線、建立新連線。
- 房主 WebSocket 重連（含重新整理、另一分頁取代）後，伺服器把直播改為未開播
  （protocol.md「房主重新連線」）。房主端關閉所有舊連線；若片源仍在，再送
  `stream:status { live: true }`，依伺服器送來的 `peer:request` 對每位收看者重新建立。
- **逐人關閉**：房主踢人、或收到 `room:members` 看到某成員消失／`online: false` 時，
  由房間層呼叫 `removePeer(memberId)`（冪等），取消該人在途的建連、ICE restart 與
  統計計時。

### 實作注意事項（`features/transport/p2p/`，GPT）

以下都是踩過的坑（見 AGENTS.md「影片與 WebRTC」），GPT 實作 p2p/ 時照做，不要猜：

1. **codec 優先 H.264**：`addTransceiver` 之後用 `common/encoding.ts` 的 `applyCodecPreferences(transceiver, options.getCodecCapabilities(transceiver.kind))`（H.264 → VP8），音訊只送 Opus。capabilities 由注入的 `getCodecCapabilities` 提供（預設 `browserCodecCapabilities`），測試可注入假的。收看端（尤其 Android）不一定能解 HEVC；房主端解碼後已重新編碼，送出要選 H.264。
2. **4K 要縮放**：`applyVideoEncoding()` 會設 `scaleResolutionDownBy = max(1, sourceHeight / targetHeight)`。4K 片源不設會以 4K 編碼，頻寬和 CPU 爆掉。
3. **`captureStream()` 只呼叫一次**：所有連線共用 `HostTransportOptions.stream`（同一個 `MediaStream`）；換片用 `replaceTrack`，不要重建連線。capture track 由 `features/source/`（T-106）持有與停止，**傳輸層不 stop 這些 track**。
4. **監聽 `addtrack`／`removetrack`**：影片播完時 Chrome 會把擷取的 track 從 stream 移除，重播是新的 track 物件。上層 `useLocalSource(onStreamChange)` 已把這件事包好；房主傳輸接到新 stream 時用 `replaceTrack(kind, track)` 換上，不能假設 track 物件永遠不變。
5. **ICE candidate 先暫存**：candidate 可能比 SDP 先到。在 `setRemoteDescription` 之前收到的 candidate 先放進佇列（依成員、依當次協商分開），remote description 設好後再依序 `addIceCandidate`。
6. **音訊不要開 `echoCancellation`／`noiseSuppression`／`autoGainControl`**：那是給麥克風用的，會修壞電影音效。captureStream 的軌道預設就是關的；`applyAudioEncoding()` 只設 maxBitrate，不要再動這三個。
7. **每次建連線前取 ICE**：`common/ice.ts` 的 `fetchIceServers(roomId, token)`（或注入的 `options.fetchIceServers`）。TURN 憑證短效，不要快取。
8. **`onPeerRequest` 觸發時**：若同一個 `memberId` 已有連線，先 `close()` 舊的再建新的（收看者重連或房主接手）。房主踢人／成員離線則走 `removePeer(memberId)`（見 §3「失敗與重連」）。
9. **信令格式**：`RtcPeerConnection` adapter（`common/rtc.ts`）已把 `RTCIceCandidate` 正規化成 `{ candidate: string, ... }`、把 offer/answer 的 `sdp` 保證為非空 string。收到 `onicecandidate` 且 `candidate === null` 時送 `{ type: "ice", candidate: null }`（end-of-candidates）。這些值可直接塞進 `SignalData`（shared 要求 string）。
10. **統計**：每 2 秒用 `common/stats.ts` 的 `StatsSampler` 取碼率／RTT／遺失。房主方向 `"send"`、收看者方向 `"receive"`；透過 `onStats` 回報。收看者側由房間層送 `member:status`（傳輸層不直接送 `member:status`，它只有 signal 介面）。
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

- 只有房主可切換：`room:update { mode: 'p2p' | 'relay' }`，伺服器廣播 `room:updated`。
- **傳輸物件的 `mode` 是建立時固定的**：切換 = 拆掉舊傳輸、建立新傳輸，不是改欄位。
  由**房間層（hook）**協調，傳輸只負責建立、傳送、銷毀。

### 直播中切模式（避免漏掉 `peer:request`）

伺服器在 `room:updated` 之後**會立刻**對每位在線收看者發 `peer:request`（P2P）。若
房間層等 React effect 才建立新傳輸並訂閱，就會漏掉。因此直播中切模式採「**先停再開**」：

```
房主（直播中）：
  1. 送 stream:status { live: false }（先宣布停止）
  2. 送 room:update { mode }（切模式）
  3. 收到 room:updated：old.destroy() → createHostTransport({ mode: 新mode, stream: 同一個 })
  4. await start()  ← p2p：signal 訂閱就緒；relay：WHIP 回 201 且套用 answer
  5. 送 stream:status { live: true }（伺服器這時才發 peer:request，訂閱已就緒）

收看者：
  1. 收到 stream:status { live: false } → 關掉舊連線／WHEP
  2. 收到 room:updated → old.destroy() → createViewerTransport({ mode: 新mode })
     - p2p  ：await start()（訂閱就緒，等房主 offer）
     - relay：等 stream:status { live: true } 再 start()
```

- **stream 不重建**：房主換模式沿用同一個 `captureStream()`，只換傳輸物件。
- **WHIP 何時就緒**：房主 relay 的 `start()` 在 WHIP 回 `201` 且套用 answer 後才
  resolve；房間層要 `await start()` 之後才送 `live: true`，收看者的 WHEP 才不會撞
  `409 STREAM_NOT_LIVE`。
- 預期中斷數秒，UI 顯示「切換中」。

### 房主重新連線（protocol.md「房主重新連線」）

依 protocol.md 的順序，關鍵是「**訂閱就緒才宣布開播**」：

1. 伺服器把直播改為未開播，對其他成員送 `stream:status { live: false }`。
2. 回房主 `room:snapshot`（`stream.live: false`）。
3. 房主端若仍有片源與開播意圖：先 `old.destroy()` → `createHostTransport(...)` →
   `await start()`（p2p 訂閱就緒）→ 送 `stream:status { live: true }`。
4. 伺服器廣播 live，P2P 下對每位收看者發 `peer:request`（房主已訂閱，不會漏）。

- 房主傳輸收到一連串 `peer:request`：同一個 `memberId` 已有連線就先 `close()` 舊的、
  建新的（見 §3「失敗與重連」）。**stream 沿用同一個**，不重新 `captureStream()`。

### 已經開播才加入的收看者

- 收看者加入時收到的 `room:snapshot` 若 `stream.live: true`，房間層直接
  `createViewerTransport(...)` → `await start()`（relay 送 WHEP；p2p 訂閱等 offer），
  不必再等一次 `stream:status`。

## 7. 收看端播放（`features/player/`）

- `<video autoplay playsinline>`，`srcObject = remoteStream`。
- **`remoteStream` 是固定的 `MediaStream`**：每個 viewer transport 建立時就 new 一個，
  T-110 只要綁一次 `srcObject`。傳輸在 `ontrack` 用 **`event.track`** 加進 remoteStream
  （不要依賴 `event.streams`，Chrome 上 sendonly transceiver 的 `event.streams` 是空的）；
  停止或重連時移除舊 track。
- 瀏覽器的自動播放政策會擋有聲音的自動播放：進房顯示「點擊開始觀看」覆蓋層，點擊後才 `play()`。`play()` 被拒時恢復覆蓋層。
- 狀態提示：等待房主開播、連線中、播放中、緩衝中、連線失敗（提供「重新連線」按鈕）。
- 收看者沒有播放控制列，只有音量與全螢幕。

## 8. 連線統計

- 每 2 秒用 `getStats()` 取樣。前端用 `features/transport/common/stats.ts` 的
  `StatsSampler(getStats, direction)`，房主方向 `"send"`（加總 `bytesSent`）、收看者
  方向 `"receive"`（加總 `bytesReceived`）；**影音各一條 RTP stream，碼率是兩條加總**。
  RTT 依 `transport.selectedCandidatePairId` 找對應 candidate-pair；`packetsLost` 負值
  夾到 0，遺失率夾到 0～1。
- 收看者每 5 秒送 `member:status { state, bitrateKbps, rttMs, packetLoss }`，伺服器只轉給房主，房主的成員列表顯示每人連線品質。`member:status` 由**收看者的房間層**送（傳輸層只暴露 `onState`／`onStats` 事件，沒有送 `member:status` 的介面）；房主只發本地 `onPeerState`。

## 9. 傳輸層契約（`features/transport/`）

> 這節是定案契約，實作型別在 `features/transport/index.ts`（介面）與 `common/`（共用實作）。
> 分工：`index.ts` 介面、`common/`、`relay/` 歸 Claude；`p2p/` 歸 GPT。

### 兩個工廠

```ts
createHostTransport({ stream, signal, mode, quality, roomId, token }): HostTransport
createViewerTransport({ signal, mode, roomId, token }): ViewerTransport
```

- 可注入：`fetchIceServers`（預設 `common/ice.ts`）、`createPeerConnection`（預設瀏覽器
  adapter）、`getCodecCapabilities`（預設 `browserCodecCapabilities`）。
- `token` 是 `hostToken`／`memberToken`（機密，不可寫進 log）。
- `start()` 回傳 `Promise`，**resolve 才代表就緒**：relay 在 WHIP／WHEP 回 201 且套用
  answer 後、p2p 在 signal 訂閱就緒後。房間層要 `await start()` 之後才送
  `stream:status { live: true }`。
- `stop()` 停止但保留物件（可再 start）；`destroy()` 釋放所有連線、監聽、計時，之後不可用。
  `stop()`／`destroy()` 都要冪等，重複呼叫是 no-op。`destroy()` 之後晚到的回應／事件一律
  丟棄，不再觸發 onState／onError。

### track 所有權

- captureStream 產生的 track 由 `features/source/`（T-106）持有與停止，**傳輸層絕不
  `stop()` 這些 track**。`destroy()` 只釋放 RTCPeerConnection 與監聽，不碰 capture track。
- 換片／切模式／重連時，下一個傳輸沿用同一份 capture stream。
- 房間層把 `useLocalSource(onStreamChange)` 的 stream 變化，轉成各 kind 的 track 或 null，
  呼叫 `host.replaceTrack(kind, track | null)`。`null` 代表「暫時沒有這個 kind 的 track」
  （例如影片播完），**不是停止直播**；停止直播用 `stop()`。
- 傳輸會記住最新的 track 與畫質，套用到現有與之後新建的 sender，並依新影片高度重算縮放。

### `signal`：傳輸層需要的最小介面（不依賴 lib/signal.ts）

```ts
interface TransportSignal {
  sendSignal(to: string, data: SignalData): boolean; // false = 送出失敗
  onSignal(handler: (message: { from: string; data: SignalData }) => void): () => void;
  onPeerRequest(handler: (request: { memberId: string }) => void): () => void;
}
```

- `onPeerRequest` 只在房主端有用。T-115 不依賴 T-105；GPT 寫 p2p/ 可用 fake signal 測試。
- `sendSignal` 回 `false` 時（WebSocket 未連線等），adapter 要把它轉成 `SIGNAL_ERROR`。

### `HostTransport`（房主）回傳物件

| 成員 | 型別 | 說明 |
| --- | --- | --- |
| `mode` | `Mode` | 建立時固定，切換 = 重建 |
| `stream` | `MediaStream` | 送出的 captureStream（所有連線共用） |
| `start()` | `Promise<void>` | relay：WHIP 201 + answer 後 resolve；p2p：訂閱就緒後 resolve |
| `stop()` / `destroy()` | `void` | 冪等；destroy 不 stop capture track |
| `replaceTrack(kind, track)` | `void` | 換片／track 異動（`track=null` = 暫時沒有該 kind） |
| `setQuality(quality)` | `Promise<void>` | 依序套用到所有 sender，失敗帶 memberId 的 `TRACK_ERROR` |
| `removePeer(memberId)` | `void` | 冪等；關閉該成員連線並取消在途建連／ICE restart／統計 |
| `onState(handler)` | `HostTransportState = "idle" \| "live" \| "error"` | 整體狀態 |
| `onPeerState(handler)` | `{ memberId, state: MemberState }` | 每位收看者的**本地**連線狀態（P2P；relay 不觸發） |
| `onStats(handler)` | `TransportStats & { memberId? }` | P2P 每 2 秒每位收看者；relay 回報單一上傳統計 |
| `onError(handler)` | `TransportError` | 錯誤，`memberId` 指出是哪位收看者 |

### `ViewerTransport`（收看者）回傳物件

| 成員 | 型別 | 說明 |
| --- | --- | --- |
| `mode` | `Mode` | 建立時固定 |
| `remoteStream` | `MediaStream` | 建立時就 new 的固定 MediaStream；用 ontrack 的 `event.track` 加 track |
| `start()` | `Promise<void>` | relay：WHEP 201 + answer 後 resolve；p2p：訂閱就緒後 resolve |
| `stop()` / `destroy()` | `void` | 冪等；stop 移除 remoteStream 舊 track |
| `onState(handler)` | `ViewerTransportState = MemberState` | `waiting`／`connecting`／`playing`／`failed`（`buffering` 由播放器回報） |
| `onStats(handler)` | `TransportStats` | 每 2 秒（方向 `"receive"`） |
| `onError(handler)` | `TransportError` | 錯誤 |

### 共用型別

```ts
type TransportStats = { bitrateKbps: number; rttMs?: number; packetLoss?: number }; // packetLoss 0–1
type TransportErrorCode =
  | "ICE_UNAVAILABLE" | "SIGNAL_ERROR" | "PEER_FAILED" | "TRACK_ERROR"
  | "RELAY_FAILED" | "STREAM_NOT_LIVE" | "RELAY_UNAVAILABLE";
class TransportError extends Error { code; message; memberId?; cause? }
```

- `STREAM_NOT_LIVE`：收看者 WHEP 回 409，回到 `waiting`（不是致命錯誤）。
- `RELAY_UNAVAILABLE`：轉發服務回 503，提示停用轉發。若要在使用者選之前就停用轉發選項，
  需要伺服器提供能力旗標（另開任務）。

### 狀態轉換

**房主整體（`HostTransportState`）**

| 狀態 | 進入 | 離開 |
| --- | --- | --- |
| `idle` | 建立後、或 `stop()` | `start()` resolve → `live` |
| `live` | `start()` resolve | `stop()`／`destroy()` → `idle`；致命錯誤 → `error` |
| `error` | 致命錯誤（加 track、ICE 全掛等） | 只能 `destroy()` 後重建 |

**房主逐人連線（`onPeerState`，transport 層的本地判斷）**

| 狀態 | 進入 | 離開 |
| --- | --- | --- |
| `connecting` | 收到 `peer:request`，建連中 | answer 到 + ICE 連通 → `playing`；失敗 → `failed` |
| `playing` | ICE 連通（連線通了、媒體在送） | ICE `disconnected`/`failed` → 進 restart（算 `connecting`）；`removePeer` → 移除 |
| `failed` | restart 3 次仍失敗、或 answer 15 秒沒到 | `removePeer` 移除 |

**收看者（`ViewerTransportState`，transport 層）**

| 狀態 | 進入 | 離開 |
| --- | --- | --- |
| `waiting` | 建立後、或 `stop()`；WHEP 回 409 | `start()` → `connecting` |
| `connecting` | `start()` 建連中 | ICE 連通 → `playing`；失敗 → `failed` |
| `playing` | ICE 連通（收到媒體） | `stop()` → `waiting`；ICE 斷線 → `connecting` |
| `failed` | 連線失敗、無法自動恢復 | 房間層「重新連線」→ 重建 |

- **`playing` 是「連線通了」，不是「真的在播」**。真正卡住（`buffering`）由**播放器
  （T-110）**偵測 `<video>` 播放停滯後回報，房間層把它併進 `member:status`。收看者的
  房間層每 5 秒送 `member:status`；房主只發本地 `onPeerState`，不送 `member:status`。

### 生命週期與誰協調

- **傳輸層**只負責建立／傳送／統計／銷毀，不碰 React、不碰 `member:status`／`stream:status`。
- **房間層（hook）**負責：何時建立／銷毀傳輸（含模式切換、房主重連）、把 `onState`／
  `onStats` 轉成 `member:status`、送 `stream:status`、把 `TransportSignal` 接到真正的 SignalClient。

### 匯出位置（p2p/ 與 relay/ 的交付）

| 檔案 | 匯出 | 負責 |
| --- | --- | --- |
| `features/transport/p2p/index.ts` | `createP2PHostTransport: CreateHostTransport`、`createP2PViewerTransport: CreateViewerTransport` | GPT |
| `features/transport/relay/index.ts` | `createRelayHostTransport: CreateHostTransport`、`createRelayViewerTransport: CreateViewerTransport` | Claude |
| `features/transport/index.ts` | 型別與介面（本檔）；dispatcher `createHostTransport`／`createViewerTransport`（依 `mode` 選 p2p/ 或 relay/）等 T-107、T-109 合併後由 Claude 補上 | Claude |

### `RTCPeerConnection` 介面與 fake

- 傳輸層一律透過 `common/rtc.ts` 的 `RtcPeerConnection` 介面與瀏覽器 adapter，不直接用
  原生 `RTCPeerConnection`。adapter 記下 kind、正規化 candidate 與 sdp（保證非空 string）。
- 單元測試用 `common/rtc-fake.ts` 的 `createFakePeerConnectionFactory()` 注入
  （testing.md），不依賴真實瀏覽器。
