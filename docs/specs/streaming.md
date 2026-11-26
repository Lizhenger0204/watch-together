# 規範：串流（選片、編碼、P2P、轉發）

## 1. 影片來源（房主端，`features/source/`）

### 支援格式

使用者約定片源統一為 **H.264 或 H.265（HEVC）影像 + AAC 音訊**。

| 容器 | 支援度 | 處理 |
| --- | --- | --- |
| mp4 / m4v / mov | 正式支援 | 直接播放 |
| mkv | Chrome / Edge 非正式支援，多數 H.264/HEVC + AAC 可播 | 允許選擇，但以下方檢查為準；失敗時提示改用 mp4 |
| 其他 | 不支援 | 檔案選擇器不列出 |

- HEVC 是否能原生播放取決於作業系統、瀏覽器、可用的 HEVC 解碼器與檔案格式，必須以房主電腦的實際試播確認；不可只依平台名稱或 `canPlayType()` 宣告支援。房主仍限桌面 Chrome / Edge，並須能以 `captureStream()` 擷取影音。
- 能力依據：[Chromium 影音支援說明](https://new.chromium.org/audio-video/) 列出 HEVC 的硬體支援條件；[Microsoft Edge 播放排查](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues) 說明 Windows Edge 的 HEVC 延伸模組及解碼器路徑限制。這不保證所有 HEVC profile、位元深度與容器都能播放。
- 檔案選擇器 `accept`：`video/mp4,video/quicktime,.mp4,.m4v,.mov,.mkv`。

### 開播前檢查（全部通過才允許開播）

1. 用 `URL.createObjectURL(file)` 載入到 `<video>`，等 `loadedmetadata`，逾時 10 秒視為失敗。
2. `videoWidth > 0 && videoHeight > 0`，否則提示「影像無法解碼（可能是 HEVC 不支援或容器不支援）」。
3. 試播 1 秒（靜音），確認 `captureStream()` 取得 1 條 video track，且至少 1 條 audio track；沒有音軌時提示「音訊無法解碼」，讓房主選擇是否繼續。
4. 檢查結束後回到 0 秒、暫停，取消靜音。

### 本地播放與擷取

- 房主端用**自訂控制列**操作本地 `<video>`（播放、暫停、拖進度、音量）。收看者看到的是擷取後的畫面，不需要額外同步。
- 控制列是房主與收看端共用的圖示元件（`components/player/PlayerControls`，T-125）。每組控制都是選填，依角色決定要顯示哪些：

  | 控制 | 房主 | 收看者 |
  | --- | --- | --- |
  | 播放／暫停、進度條與時間 | ✓ | — |
  | 音量（靜音鍵＋滑桿） | ✓ | ✓ |
  | 畫質（按鈕顯示目前畫質，點開面板調整，§2） | ✓ | — |
  | 彈幕（開關與密度：少／中／多，從右往左飄過播放器容器） | ✓ | ✓ |
  | 聊天室入口（展開／收起聊天側欄） | — | ✓ |
  | 劇院模式（桌面寬度才有：側欄移到影片下方，影片滿寬） | ✓ | — |
  | 全螢幕（對象是播放器容器，控制列與彈幕層一起進全螢幕） | ✓ | ✓ |

  純圖示按鈕都要有 `aria-label` 與 `title`（DESIGN.md §5）。畫質、劇院模式只由房間頁的房主視圖傳入，收看端元件不接受這兩組控制。音量拖到 0 後取消靜音，回到最後的非零音量。
- 彈幕同一軌道依實際文字寬度、目前播放器寬度與滑行速度排程，前後兩則不重疊。**例外**：彈幕已經在畫面上之後播放器才改變寬度（例如退出全螢幕），動畫依進度移動，在途的兩則可能短暫靠近或重疊，這是可接受的取捨。
- AGENTS.md 的「`captureStream()` 只呼叫一次」以**同一次選檔**為單位。T-106 擷取一次，所有連線共用這份片源。換檔時 T-106 釋放舊 track，為新檔案擷取新的 `MediaStream`。Chrome 實測兩次擷取的物件不同，舊的 video track 已是 `ended`。
- 房主端音量：T-106 在 Chrome 158（macOS）實測，`video.volume = 0` 與 `video.muted = true` 都**不影響**擷取出去的音訊（AnalyserNode RMS 幾乎相同），因此房主本地音量直接調 `video.volume`。Windows Edge 列入 T-113 驗收。
- **影片播完時 Chrome 會把擷取的 track 從 stream 移除**，重播時會加入新 track。換檔、`addtrack` 或 `removetrack` 都由 `useLocalSource(onStreamChange)` 通知房間層，後者以 `host.replaceTrack(kind, track | null)` 更新現有傳輸。需要重建傳輸時，再從 T-106 讀取當下的 stream（§9）。
- 房主關閉或重新整理分頁 = 停止直播。分頁在背景時要能繼續推流（實測項目）。

## 2. 編碼與畫質（`features/transport/common/`）

### 畫質（三條分段滑桿，T-126）

房主點控制列的「畫質」按鈕（文字顯示目前解析度，例如 `1080P`），在彈出面板用三條分段滑桿調整，放開即套用：

| 滑桿 | 檔位 | 說明 |
| --- | --- | --- |
| 解析度 | `720P`／`900P`／`1080P` | 目標高度。**不超過片源**：高於片源高度的檔位停用；房間設定比片源高時以片源高度送出（不放大） |
| 位元率 | `8 Mbps`／`10 Mbps`／`15 Mbps`／`原片` | 每位收看者的 `maxBitrate` |
| FPS | `24`／`30`／`60`／`原片` | `maxFramerate`；`原片` 不設上限，沿用片源幀率 |

- 預設 `1080P`、`8 Mbps`、`30`（`DEFAULT_QUALITY`）。
- 房間只記住**檔位**（protocol.md 的 `Quality`）。實際編碼參數由房主端 `resolveQuality(quality, sourceBitrate)` 算出 `EncodingTarget { targetHeight, maxBitrate, maxFramerate | null }` 再交給傳輸層。
- **原片位元率**：選檔後以 `檔案大小 × 8 ÷ 片長` 估計（含音軌，`estimateSourceBitrate`）。量不到時用 15 Mbps（`SOURCE_BITRATE_FALLBACK`），最高 50 Mbps（`SOURCE_BITRATE_MAX`）。檔位是「原片」時換片會依新片重新估計並套用。
- 調整時房主送 `room:update { quality }`，收到 `room:updated` 後對現有傳輸 `setQuality(encodingTarget)`（`setParameters`，不重建連線）。開播、停播、切換傳送方式或斷線同步中暫時停用畫質面板。
- **連續調整以「最後的選擇」為準**（`host-session-quality.ts`）：每次放開滑桿都與「最後的選擇」比較（不是與廣播來的舊值比較）後送出；面板保留最後的選擇，直到依序收到相符的畫質廣播，且最後一筆請求已獲伺服器接受。鎖房或換邀請碼等無關廣播不影響尚未確認的選擇。最後一筆請求被拒絕或逾時時，面板顯示房間目前的畫質，並回報錯誤。重新驗證、斷線或等待畫質廣播逾 10 秒也會清除尚未確認的選擇。
- **滑桿位置就是房間設定的檔位，不因片源而被夾住。** 房間設定不因片源而被改寫：片源 1000P、設定 1080P 時，解析度滑桿停在 1080P、右上角顯示實際送出的「1000P（片源）」，可選檔位只有 720P／900P，往左拉到 900P 就是一次可提交的變更；高於片源的檔位淡化且拉過去會被夾回。片源只有 720P 以上、900P 以下時只有 720P 可選，一樣能從 1080P 設定直接選到 720P。
- 位元率滑桿的「原片」顯示的估計值與實際送出的上限一致（最高 50 Mbps）。
- 收看者不顯示畫質控制。
- **4K 片源要縮放**：`scaleResolutionDownBy = max(1, videoHeight / 目標高度)`，否則會以 4K 編碼。
- `videoTrack.contentHint = 'motion'`；`degradationPreference = 'maintain-framerate'`。
- Codec 偏好：**H.264 優先**（收看端 Android 硬體解碼最普遍），其次 VP8。用 `RTCRtpTransceiver.setCodecPreferences` 設定。
- 音訊：Opus，`maxBitrate` 128 kbps，關閉 `echoCancellation` / `noiseSuppression` / `autoGainControl`（這些是給麥克風用的）。

### P2P 總頻寬保護

- 一般 3 位收看者，上限 7 位。
- 預估總上傳量 = 實際位元率（`EncodingTarget.maxBitrate`）× 收看人數；超過 60 Mbps 時提示房主調低位元率或改用「轉發」模式，但不強制。

### 實作位置

- 編碼參數、codec 偏好：`features/transport/common/encoding.ts`（`applyVideoEncoding`、`applyAudioEncoding`、`applyCodecPreferences`、`preferredVideoCodecs`／`preferredAudioCodecs`）。
- 總頻寬預估：`features/transport/common/stats.ts`（`estimateTotalUploadBitrate`、`shouldWarnTotalUpload`）。
- 畫質檔位、預設值與解析：`packages/shared/src/quality.ts`（`DEFAULT_QUALITY`、`resolveQuality`、`estimateSourceBitrate`）；檔位常數與 schema 在 `schemas/common.ts`（`RESOLUTION_STEPS`、`BITRATE_STEPS`、`FRAMERATE_STEPS`、`qualitySchema`）。

## 3. P2P 模式（`features/transport/p2p/`）

### 拓撲

房主與每位收看者各一條 `RTCPeerConnection`（mesh）。收看者之間不連線。

### 建立流程（房主主動發起）

1. 房主的 `start()` 裝好 `onPeerRequest`、`onSignal` 並記住目前各 kind 的 track（可為 null）與畫質即 resolve。此時即使房內沒有收看者，也可以宣布開播。
2. 開播時，伺服器對每位在線收看者送 `peer:request { memberId }` 給房主。直播中有收看者驗證成功時，伺服器也會為這位成員送出請求。
3. 房主收到請求後，先登記該成員這次的 `negotiationId` 再建連。**首次 offer 前，video、audio 各保留一個 sendonly transceiver**。每個 kind 用 `addTransceiver(track ?? kind, { direction: 'sendonly' })` 建立。缺軌時 `sender.track` 為 null，之後以同一個 sender 的 `replaceTrack` 補上。例如無聲片換有聲片時，沿用原本協商好的 audio transceiver。
4. 房主在兩個 transceiver 設定 codec 偏好，套用最新 tracks、畫質與縮放（§2），再 `createOffer()` → `setLocalDescription(offer)` → 送 `signal { to: memberId, data: { type: 'offer', negotiationId, sdp } }`。
5. 收看者記下房主及 offer 的 `negotiationId`，依序 `setRemoteDescription(offer)` → `createAnswer()` → `setLocalDescription(answer)`，再回 `signal { to: hostId, data: { type: 'answer', negotiationId, sdp } }`。房主依下列規則比對後才套用 answer。
6. 雙方用 `signal { to, data: { type: 'ice', negotiationId, candidate } }` 交換 trickle ICE，包括 `candidate: null`。連通後收看者的房間層依 `onState` 回報 `member:status { state: 'playing' }`（§8）。

### 協商識別與 ICE

1. 房主在處理 `peer:request` 或開始 ICE restart 時，立即以 `crypto.randomUUID()` 為這份 offer 配發新識別，按收看者的 `memberId` 保存。隨機值讓停播重開或換分頁後的新 offer 也能獨立配發識別，無須跨 transport 保存計數器。同一成員再觸發 `peer:request` 時關閉舊連線再建新的。ICE restart 則沿用該連線與 transceiver。
2. 雙方回傳本機 ICE 時，帶上產生該 candidate 的本機 SDP 所對應的 offer 識別。房主先在同一條 WebSocket 送出 offer，再依序送出為它收集的 ICE，讓收看者先知道新識別。若 restart 前後的本機事件重疊，以 candidate 的 `usernameFragment` 對應本機 SDP 的 `a=ice-ufrag`。缺 ufrag 的事件（含 `null`）只有在能確定屬於哪次收集時才送出。
3. 收看者收到房主的 offer 時，在第一個 `await` 前登記 `(from, negotiationId)`。answer 和本機 candidate 都原樣帶回該 offer 的識別。收到房主的 ICE 時先核對這一對值。沒有當次 offer 或值不符就靜默丟棄。
4. 房主收到 answer 或 ICE 時，先用 `from` 找到該收看者，再逐字比對其目前的 `negotiationId`。查無連線或識別不符時靜默丟棄，保留當次計時與佇列。只對仍在等待的相符 answer 呼叫一次 `setRemoteDescription(answer)`，只讓相符 ICE 進入下一步。
5. **ICE 可能早於 answer，或在套用 offer 期間到達。** 雙方依 `(from, negotiationId)` 暫存相符的 ICE，直到當次 `setRemoteDescription` 成功，再依到達順序呼叫 `addIceCandidate`。restart 時連線上可能還留著舊 SDP。candidate 若有 ufrag，要再核對當次遠端 SDP 對應媒體的 `a=ice-ufrag`，不符就丟棄。`candidate: null` 也依訊息上的識別排隊，只結束該次 ICE 收集。

換代、移除成員、停播或銷毀 transport 時，作廢舊識別，清除其 ICE 佇列、answer／重試計時與統計取樣器。在途的取 ICE、SDP、track、統計與事件回呼，在操作 RTC、送信令或回報狀態前，都要再核對所屬連線及識別。

**驗收（收看者沿用同一條 WebSocket）**

房主送出 offer A，延後交付 answer A。停播再開播後，房主對同一成員送出 offer B，接著才交付 answer A 與 A 的 `candidate: null`。新連線應維持 `have-local-offer`，兩則舊訊息都不觸發 RTC 呼叫，也不取消 B 的 answer 計時。交付 answer B 後，只套用 B 一次，連線進入 `stable`。

### 失敗與重連

- `iceConnectionState` 持續 `disconnected` 超過 5 秒，或進入 `failed` 時，房主以 `createOffer({ iceRestart: true })` 重啟 ICE。**同一次斷線最多 3 次 restart**，依序嘗試。計數跨這次斷線的協商代次保留，回到 `connected`（或直接到 `completed`）才歸零。重建的全新連線從零開始。
- **每位成員同時只等一份 answer**。首次從收到 `peer:request` 起算 15 秒，每次 restart 從送出該次 offer 起算 15 秒。期限內未收到相符的 answer 就結束這條連線。
- answer 逾時或 3 次 restart 後仍無法恢復時，房主只在本機透過 `onPeerState` 發出 `{ memberId, state: 'failed' }`，透過 `onError` 回報帶 `memberId` 的 `PEER_FAILED`，並呼叫 `removePeer(memberId)`。
- 房主踢人、或從 `room:members` 看到成員消失／`online: false` 時，房間層也呼叫冪等的 `removePeer(memberId)`，關閉連線並作廢該成員的協商代次。
- `member:status` 一律由**收看者的房間層**回報該收看者自己的狀態。伺服器會以 `FORBIDDEN` 拒絕房主送出的 `member:status`。

**收看者等待第一份 offer（P2P）**

- 房間層以本次 `room:snapshot` 的 `stream.live` 為 true 或開播廣播 `stream:status { live: true, title, startedAt }` 確認直播。確認直播且 `await viewer.start()` 已完成信令訂閱後，才開始等待首份 offer 的計時，建議 20 秒。更新片名等重複開播廣播不重設計時。
- 收到當次房主的第一份 offer 就取消計時。若訂閱就緒前已緩衝該 offer，直接交付，不啟動計時。停播、切換模式、換 WebSocket、`stop()` 或 `destroy()` 都取消舊計時。
- 逾時仍無 offer 時，房間層銷毀該次傳輸，將收看狀態設為 `failed`，以 `PEER_FAILED` 顯示「重新連線」。按下後依下列流程取得新的 `peer:request`。

**收看者手動重連（P2P）**

1. 收看者按「重新連線」時，房間層先 `old.destroy()`，移除舊 transport 的訂閱、遠端 tracks 和計時。將舊 WebSocket 退役並關閉，避免舊回呼再觸發重連。
2. 建立**新的 WebSocket**，先在房間層掛上 snapshot 與信令接收器，緩衝這條連線的 offer／ICE。再用原成員身分送第一則 `auth`。已驗證的 socket 再送 `auth` 會得到 `BAD_REQUEST`。
3. 伺服器回 `room:snapshot`。若為 P2P、正在直播且房主在線，驗證成功也會觸發給房主的 `peer:request`。房主據此作廢舊代次、重新發 offer。收看端依 §6「已經開播才加入的收看者」準備新傳輸後，依序交付緩衝的信令。網路斷線後重新驗證沿用此流程。房主重連則依 §6「房主重新連線」處理。

### 實作注意事項（`features/transport/p2p/`，GPT）

以下都是踩過的坑（見 AGENTS.md「影片與 WebRTC」），GPT 實作 p2p/ 時照做，不要猜：

1. **codec 優先 H.264**：`addTransceiver` 之後用 `common/encoding.ts` 的 `applyCodecPreferences(transceiver, options.getCodecCapabilities(transceiver.kind))`（H.264 → VP8），音訊只送 Opus。capabilities 由注入的 `getCodecCapabilities` 提供（預設 `browserCodecCapabilities`），測試可注入假的。收看端（尤其 Android）不一定能解 HEVC；房主端解碼後已重新編碼，送出要選 H.264。
2. **4K 要縮放**：`applyVideoEncoding()` 會設 `scaleResolutionDownBy = max(1, sourceHeight / targetHeight)`。4K 片源不設會以 4K 編碼，頻寬和 CPU 爆掉。
3. **片源**：T-106 負責擷取與停止 capture track。換片與重播更新各 kind 的 sender，晚加入的成員也要取得最新 tracks、畫質與縮放（§1、§9）。
4. **音訊不要開 `echoCancellation`／`noiseSuppression`／`autoGainControl`**：那是給麥克風用的，會修壞電影音效。captureStream 的軌道預設就是關的；`applyAudioEncoding()` 只設 maxBitrate，不要再動這三個。
5. **每次建連線前取 ICE**：`common/ice.ts` 的 `fetchIceServers(roomId, token)`（或注入的 `options.fetchIceServers`）。TURN 憑證短效，不要快取。
6. **信令格式**：`RtcPeerConnection` adapter（`common/rtc.ts`）將 candidate 正規化成 `{ candidate: string, ... }`（非空）或結束標記 `null`，offer／answer 的 `sdp` 保證為非空 string。P2P 傳輸組成 `SignalData` 時加上所屬 offer 的 `negotiationId`。
7. **統計**：每 2 秒透過 `onStats` 回報，資料來源與缺值規則見 §8。
8. **單元測試用 fake**：`RTCPeerConnection` 一律透過 `common/rtc.ts` 介面，測試用 `common/rtc-fake.ts` 的 `createFakePeerConnectionFactory()` 注入，不依賴真實瀏覽器（testing.md）。

## 4. 轉發模式（`features/transport/relay/` + `apps/signal/src/relay/`）

- 房主：`POST /api/rooms/:roomId/whip`，body 為 SDP offer（`Content-Type: application/sdp`），回應 `201` + SDP answer + `Location` header（資源 URL）。停止時 `DELETE` 該 `Location`。
- 收看者：`POST /api/rooms/:roomId/whep`，流程相同。
- **WHIP 與 WHEP 每次建連都只送一份 HTTP offer**。T-109 先 `setLocalDescription(offer)`，再 `await pc.waitForIceGatheringComplete(2000)`。
  若 `iceGatheringState` 已是 `complete` 就立即 resolve，否則等到 `complete` 或 2 秒上限。兩種情況都重新讀取唯讀的 `pc.localDescription`，將整份 `pc.localDescription.sdp` 作為 POST body，包含截至當時收集到的 candidates。
  若這次啟動已取消，或沒有有效的 local offer，就不送 POST。協定只提供 POST、DELETE，不支援 trickle PATCH。
- **同一房間、同一房主的 WHIP 建立與刪除必須依序完成**。T-109 要跨 transport 實例協調停播、重開、切模式與重連。停止時若舊 POST 仍在途，要等回應。舊發布一旦取得 `201` 的 `Location` 就依該 URL 執行 DELETE，包含停止後才收到回應、或套用 answer 失敗的情形。
  舊 POST 明確未建立資源，或舊發布的 DELETE 成功後，才可送下一次 WHIP POST。刪除失敗要保留待清理資源，後續建立須等待清理完成。
- `destroy()` 之後停止 UI 事件，晚到的成功回應仍要完成資源清理（WHEP 亦同）。上述序列由同一客戶端維持。跨分頁接手等情境若需要伺服器辨識發布世代，另開任務。
- apps/signal 負責呼叫 Cloudflare Realtime API 建立 session、發布或拉取 track，並把房主發布的 track 名稱存在 RoomDO。實作參考 Cloudflare 官方 `realtime-examples/whip-whep-server`，先確認其授權條款。
- P2P 模式下 WHIP、WHEP 都回 `409 STREAM_NOT_LIVE`。轉發切回 P2P 時，伺服器撤下當前發布並清理全部發布與訂閱，以免舊連線繼續傳輸。
- 新 WHIP 成功登記時，伺服器取代舊發布，關閉舊發布與連到它的 WHEP tracks。上游要求額外協商時回 `503 RELAY_UNAVAILABLE`，並關閉已知已建立的 tracks。這些清理失敗時也由房間的清理待辦重試。
- 房主未開播時，收看者的 WHEP 請求回 `409 STREAM_NOT_LIVE`，收看者等待開播廣播 `stream:status { live: true, title, startedAt }` 再請求。
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

房間若仍在直播就切到 P2P，伺服器會在 `room:updated` 後立即對房主發出 `peer:request`。房間層依下列順序切換，期間 UI 顯示「切換中」。`title` 為目前片名（去掉副檔名，符合 shared 的 `TITLE_MAX_LENGTH`），`startedAt` 由伺服器提供。

**房主**

1. 送 `stream:status { live: false, title: null, reqId }`，等待**同一 reqId** 的 `ack { reqId, ok: true }`，或本次停播後收到的廣播 `stream:status { live: false, title: null, startedAt: null }`。若停播失敗或逾時而尚未確認，停在這一步。
2. 確認停播後，停止舊傳輸，再送 `room:update { mode }`。收到目標模式的 `room:updated` 後，呼叫 `old.destroy()`。**等待 `room:updated` 有期限（10 秒）**，期限內沒收到就視為失敗。
3. 仍有片源及開播意圖時，以 **T-106 當下最新的 stream** 與目前畫質建立新 host transport。等 `start()` resolve（P2P 訂閱與 tracks／畫質就緒，relay 為 WHIP 201 且已套用 answer）。
4. 送 `stream:status { live: true, title }`。伺服器廣播 `stream:status { live: true, title, startedAt }`，並在 P2P 模式下為在線收看者發出 `peer:request`。若已換片，使用新片名。

**收看者**

1. 收到停播廣播 `stream:status { live: false, title: null, startedAt: null }` 時停止舊傳輸，關閉連線。轉發模式也須清理 WHEP。
2. 收到變更模式的 `room:updated` 時，銷毀舊 transport，依新模式建立 viewer transport。P2P 可立即 `await start()`，房間層在訂閱就緒前先緩衝新模式的信令，之後依序交付。
3. Relay 等開播廣播 `stream:status { live: true, title, startedAt }` 再 `start()` 拉取 WHEP。

### 切模式失敗的保守處理（房主房間層）

以下情況審查認可，實作照做，不要另想一套：

- **第 2 步失敗（依原因區分三種情況）**：
  - **`room:update` 明確被拒**（伺服器回 `ack { ok: false, code }`）：伺服器確定仍在原模式。銷毀舊傳輸、顯示可讀錯誤，依開播意圖用**原模式**重建（不能直接用新模式重建）。
  - **等待 `room:updated` 逾時或 `room:update` 請求逾時（結果不明）**：伺服器可能已切換也可能未切換，不可直接用原模式或新模式重建。銷毀舊傳輸、顯示可讀錯誤，**維持「直播暫停中」（`waiting`，保留開播意圖，不立即重建）**，並呼叫 `SignalClient.resync()` 關閉目前 WebSocket、建立新連線重新驗證；收到新的 `room:snapshot` 後，依 snapshot 的伺服器模式自動重建開播（若期間取消開播意圖或片源未就緒，照「房主重新連線」／`room:snapshot` 既定規則處理）。
  - **連線中斷**（`SignalDisconnectedError`）：維持既有行為，銷毀舊傳輸、保留開播意圖，等自動重連重新驗證並收到新的 `room:snapshot` 後，依 snapshot 的伺服器模式重建。
- **開播途中模式被改**（`room:update` 與開播同時進行，收到 `room:updated` 時手上還有舊傳輸）：照本節「先停再開」停播後重建，**不再送一次 `room:update`**（伺服器已經是新模式）。
- 切模式第 1 步停播失敗或逾時：停在原模式，不送 `room:update`、不停舊傳輸；若期間房主已按停止，重讀意圖繼續停播。

### 房主重新連線（protocol.md「房主重新連線」）

1. 房主在新 WebSocket 上驗證成功。若先前仍在直播，伺服器先改為未開播，對其他在線成員送 `stream:status { live: false, title: null, startedAt: null }`，讓收看者停止舊傳輸。
2. 伺服器回房主 `room:snapshot`，其中 `stream` 為 `{ live: false, title: null, startedAt: null }`。房主房間層銷毀既有 transport。被 `4000` 取代的舊分頁也要銷毀其 transport，結束該次連線。
3. 接手的房主若仍有可播放的片源與開播意圖，就用 T-106 **最新 stream**、snapshot 的模式與畫質建立新 transport。`await start()` 成功後才送 `stream:status { live: true, title }`。若片源已隨重新整理而釋放，維持未開播。
4. 伺服器廣播 `stream:status { live: true, title, startedAt }`。收看者收到後啟動該模式的傳輸。P2P 模式下，伺服器對每位在線收看者各送一則 `peer:request` 給已訂閱的房主，收看端的房間層照常緩衝直到新訂閱就緒。

### 已經開播才加入的收看者

- 在送 `auth` 前先備妥房間層的接收器，緩衝這條 WebSocket 上先到的信令。以 `room:snapshot` 的 `room.mode` 與 `stream.live` 決定如何建立 viewer transport。
- 若 `stream.live` 為 true，直接 `await start()`。P2P 在 `onSignal` 就緒後依序交付該次連線的 offer／ICE，relay 立即送 WHEP。這份 snapshot 就是開播依據。若為 false，保持等待，收到開播廣播再接收。切模式、停播或換 socket 時作廢舊信令，避免交給下一次傳輸。

## 7. 收看端播放（`features/player/`）

- `<video autoplay playsinline>`，`srcObject = remoteStream`。
- **`remoteStream` 是固定的 `MediaStream`**：每個 viewer transport 建立時就 new 一個，
  T-110 只要綁一次 `srcObject`。傳輸在 `ontrack` 用 **`event.track`** 加進 remoteStream
  （不要依賴 `event.streams`，Chrome 上 sendonly transceiver 的 `event.streams` 是空的）。
  只有在停播、`stop()`／`destroy()`，或以新連線取代舊連線時才移除舊 track。
  **同一條連線做 ICE restart 時保留 track**：Chrome 在 restart 後不會再發 `ontrack`，
  原 receiver track 仍是 live；若此時清空，連線回到 `connected` 後播放器也沒有 track。
- 瀏覽器的自動播放政策會擋有聲音的自動播放：進房顯示「點擊開始觀看」覆蓋層，點擊後才 `play()`。`play()` 被拒時恢復覆蓋層。
- 狀態提示：等待房主開播、連線中、播放中、緩衝中、連線失敗（提供「重新連線」按鈕）。
- 收看者不能暫停或拖進度，控制列只有音量、彈幕（開關與密度）、聊天室入口與全螢幕（見 §1 的表）。

## 8. 連線統計

- 每 2 秒用 `common/stats.ts` 的 `StatsSampler(getStats, direction)` 取樣。房主方向 `"send"` 讀 `outbound-rtp.bytesSent`，收看者方向 `"receive"` 讀 `inbound-rtp.bytesReceived`。碼率依同一 RTP id 算相鄰兩次的位元組差，再加總影音。
- `rttMs` 取 `transport.selectedCandidatePairId` 指向的 candidate-pair 的 `currentRoundTripTime`，由秒換算成毫秒。缺少 ID、找不到對應的 pair 或沒有 RTT，就**省略欄位**。其他 succeeded pair 的 RTT 不代表這條連線。
- 房主的 `packetLoss` 取自對端回報的 `remote-inbound-rtp`（`fractionLost` 或足以計算遺失率的封包統計）。收看者以本地 `inbound-rtp` 的 `packetsLost` 與 `packetsReceived` 計算。負的 `packetsLost` 夾到 0，遺失率夾在 0～1。缺少該方向的資料或無法計算就省略欄位。有資料且算出 0 時保留 0。
- **收看者的房間層**每 5 秒以 `member:status` 送自己的 `state` 與有值的統計欄位。伺服器只轉給房主，供成員列表顯示。

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
- `quality` 是已解析的 `EncodingTarget`（§2），不是房間的 `Quality` 檔位；房間層負責 `resolveQuality()`，傳輸層不認識「原片」。
- `start()` resolve 才代表就緒。P2P 房主已訂閱 `onPeerRequest` 與 `onSignal` 並記住當前 tracks、畫質，收看者已訂閱 `onSignal`。即使尚無 peer，兩端的 `start()` 都能完成。Relay 則須 WHIP／WHEP 回 201 且已套用 answer。只有房主的房間層會在 `await start()` 後，確認仍是當次開播才送 `stream:status { live: true, title }`。
- `stop()` 停止但保留物件（可再 start），`destroy()` 釋放連線、監聽與計時，之後不可用。兩者均冪等。`destroy()` 後不得再觸發狀態、統計或錯誤事件，仍須處理晚到的 `Location` 並完成 §4 的資源清理。

### 片源、track 所有權與畫質

- T-106 擁有並負責停止 capture tracks。`HostTransport.stream` 是建立該 transport 時傳入的 stream 引用。每次重建都從 T-106 取得當下的 stream，避免換片後又把已結束的舊 tracks 傳給下一個 transport。
- 房間層從 `useLocalSource(onStreamChange)` 取得最新 stream，按 video、audio 分別呼叫 `host.replaceTrack(kind, track | null)`。沒有 stream 或該 kind 沒有可用的 track 就傳 null，保留 sender 等待補軌。停播另用 `stop()`。
- 即使當時沒有 peer，傳輸也要記下最新的 tracks 與畫質。換片或補回 video 時依該 track 的高度重算 §2 的縮放。既有及稍後才建立的 sender 都套用最新 tracks、畫質與縮放。
- `setQuality` 先記住最新設定，再逐一套用到現有的 video sender。連續設定以最新值為準，後加入的成員也用該值。某個成員失敗時透過 `onError` 回報帶該 `memberId` 的 `TRACK_ERROR`（relay 的單一上傳沒有 memberId），繼續處理其餘成員，保留已成功的設定。該次所有 sender 處理完後，若有失敗，Promise 以第一個錯誤 reject。

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
| `stream` | `MediaStream` | 建立時傳入的 T-106 stream |
| `start()` | `Promise<void>` | P2P 訂閱與 tracks／畫質就緒，或 WHIP 201 且已套用 answer |
| `stop()` / `destroy()` | `void` | 冪等，保留來源 tracks。WHIP 清理與後續發布依 §4 排序 |
| `replaceTrack(kind, track)` | `void` | 換片／track 異動（`track=null` = 暫時沒有該 kind） |
| `setQuality(target: EncodingTarget)` | `Promise<void>` | 記住最新編碼目標，逐人套用，個別失敗回報 `TRACK_ERROR` |
| `removePeer(memberId)` | `void` | 冪等，關閉該成員連線並作廢其協商代次（§3） |
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
| `live` | `start()` resolve | `stop()` → `idle`，致命錯誤 → `error`，`destroy()` 結束事件 |
| `error` | 整體傳輸無法繼續（例如 WHIP 建立失敗） | `destroy()` 後重建 |

**房主逐人連線（`onPeerState`，transport 層的本地判斷）**

| 狀態 | 進入 | 離開 |
| --- | --- | --- |
| `connecting` | 收到 `peer:request` 或開始 ICE restart | 套用當次 answer 且 ICE 連通 → `playing`，最終失敗 → `failed` |
| `playing` | ICE 連通，斷線重試計數歸零 | `disconnected` 超過 5 秒或 `failed` → restart（`connecting`），`removePeer` → 移除 |
| `failed` | 首次或 restart 等 answer 逾 15 秒，或同一次斷線 3 次 restart 仍失敗 | 本地發出 `onPeerState`、`onError`（`PEER_FAILED`），再 `removePeer` |

**收看者（`ViewerTransportState`，transport 層）**

| 狀態 | 進入 | 離開 |
| --- | --- | --- |
| `waiting` | 建立後、或 `stop()`；WHEP 回 409 | `start()` → `connecting` |
| `connecting` | `start()` 建連中 | ICE 連通 → `playing`；失敗 → `failed` |
| `playing` | ICE 連通 | `stop()` → `waiting`，ICE 斷線 → `connecting` |
| `failed` | 連線失敗、無法自動恢復 | 房間層手動重連，P2P 依 §3 重建並在新 WebSocket 驗證，relay 在直播時重新拉取 WHEP |

- `playing` 表示連線已通。**播放器（T-110）**偵測 `<video>` 播放停滯後回報 `buffering`，由收看者的房間層併入每 5 秒送出的 `member:status`。
- P2P 等待第一份 offer 的 `failed` 由房間層依 §3 計時並回報給 UI 與 `member:status`。房間層可同時觀察直播狀態、信令訂閱與已緩衝的 offer。

### 生命週期與誰協調

- **傳輸層**只負責建立／傳送／統計／銷毀，不碰 React、不碰 `member:status`／`stream:status`。
- **房間層（hook）**協調建立／銷毀傳輸、模式切換與重連，並將 `TransportSignal` 接到 SignalClient。收看者把自己的 `onState`／`onStats` 轉成 `member:status`。開播、停播的 `stream:status` 由房主送出。

### 房主房間層的廣播與錯誤處理（保守判斷）

以下情況審查認可，實作照做：

- **收到不是自己要求的 `stream:status { live: false }` 廣播**、手上又有傳輸時：拆掉傳輸，依開播意圖重新開播（伺服器可能是被另一分頁接手或主動改為未開播）。
- **傳輸 `onState` 為 `error`**（整體無法繼續）：取消開播意圖並送 `stream:status { live: false }`，讓收看者停止舊連線；顯示可讀錯誤。
- **個別收看者的 `PEER_FAILED` 不顯示給房主**：由傳輸自己 `removePeer` 清理。個別失敗不影響 `room:members` 的 `online`。

### 匯出位置（p2p/ 與 relay/ 的交付）

| 檔案 | 匯出 | 負責 |
| --- | --- | --- |
| `features/transport/p2p/index.ts` | `createP2PHostTransport: CreateHostTransport`、`createP2PViewerTransport: CreateViewerTransport` | GPT |
| `features/transport/relay/index.ts` | `createRelayHostTransport: CreateHostTransport`、`createRelayViewerTransport: CreateViewerTransport` | Claude |
| `features/transport/index.ts` | 型別與介面（本檔）；dispatcher `createHostTransport`／`createViewerTransport`（依 `mode` 選 p2p/ 或 relay/）。T-109 交付前，`relay` 模式同步丟出 `RELAY_UNAVAILABLE` | Claude |

### `RTCPeerConnection` 介面與 fake

- 傳輸層一律透過 `common/rtc.ts` 的 `RtcPeerConnection` 介面與瀏覽器 adapter，不直接用
  原生 `RTCPeerConnection`。adapter 記下 kind、正規化 candidate 與 sdp（保證非空 string）。
- 單次 HTTP offer（§4）透過同一介面讀取唯讀的 `RtcPeerConnection.localDescription`（`RtcSessionDescription | null`），並以 `waitForIceGatheringComplete(timeoutMs: number): Promise<void>` 有界等待。瀏覽器 adapter 與 fake 都提供這兩個入口。
- 單元測試用 `common/rtc-fake.ts` 的 `createFakePeerConnectionFactory()` 注入
  （testing.md），不依賴真實瀏覽器。
