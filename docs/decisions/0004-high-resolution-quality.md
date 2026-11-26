# ADR 0004：畫質支援 1080P 以上（1440P／2160P／原片解析度）

- 狀態：已採用（T-136；使用者 2026-11-26 同意 D1～D6，D6-4 選擇升版）
- 日期：2026-11-26
- 相關：streaming.md §1（BUG-004 的 10-bit 轉換）與 §2、protocol.md `Quality`、ADR 0002
- 編號：原草稿為 0003，與先建立的 `0003-mkv-hevc-source.md`（T-135，擱置）撞號，改為 0004

## 背景

T-126 的畫質滑桿只到 1080P，4K 片源一律以 `scaleResolutionDownBy` 縮到 1080P 以下。使用者希望房主可以選 1440P、2160P（4K）與「原片」（不縮放），收看端真的收到高解析度。預設畫質維持 1080P、8 Mbps、30 FPS。

## 實測（2026-11-26）

**環境**：Apple M1、macOS、Google Chrome 158.0.8127.88，Playwright `channel: 'chrome'`。同一頁建立兩條 `RTCPeerConnection`，走本機 loopback。片源以 ffmpeg 產生，內容是 `testsrc2` 加時間雜訊，難以壓縮：

- 3840×2160 H.264、HEVC 30 FPS
- 3840×2160 HEVC 60 FPS
- 2560×1440 H.264 30 FPS

播放方式與房主端相同：`<video>` 播放 → `captureStream()` → `addTransceiver(sendonly)` → `setCodecPreferences` 限定單一 codec → `setParameters`。每秒讀一次 `getStats()`。

> Chrome 只有在頁面取得鏡頭或麥克風權限時，`getStats()` 才會提供 `encoderImplementation`／`decoderImplementation`。實測時另外呼叫了 `getUserMedia`。**正式房主頁拿不到這兩個欄位，不能用它們判斷是否為硬體編碼。**

### 1. 各 codec 編 4K（單一收看者，`maxBitrate` 30 Mbps，`maxFramerate` 30，45 秒）

| codec | 編碼器 | 收看端最終解析度與 FPS | 房主端 Chrome CPU（全部程序加總） |
| --- | --- | --- | --- |
| H.264 | **VideoToolbox（硬體）** | 3840×2160 @ 30 | 約 80% |
| H.265 | VideoToolbox（硬體） | 3840×2160 @ 30 | 約 80% |
| VP9 | libvpx（軟體） | 3840×2160 @ 30 | 約 200～260% |
| AV1 | libaom（軟體） | 3840×2160 @ 30 | 約 290～380% |
| VP8 | libvpx（軟體） | 整段停在 1280×720 | 約 75% |

- M1 上 H.264 由硬體編碼，可以穩定送出 4K30。VP9／AV1 是軟體編碼，CPU 負擔是 H.264 的 3～5 倍，**沒有理由在高畫質時改用 VP9／AV1**。
- H.265 雖然也是硬體編碼，但收看端（Windows Chrome 沒有 HEVC 擴充、多數 Android WebRTC）不一定能解。不改變「H.264 優先」。
- `navigator.mediaCapabilities.encodingInfo({ type: 'webrtc' })` 對 H.264 4K 回 `powerEfficient: false`，實際上卻是硬體編碼。**它的結果不可靠，不能拿來在開播前判斷。**
- 關掉硬體編碼（`--disable-accelerated-video-encode`）時改用 **OpenH264**。前 15 秒能維持 4K30，之後 `qualityLimitationReason = 'cpu'`，FPS 一路降到 11。**沒有硬體 H.264 編碼器的電腦送不了 4K。**
- 片源解碼加 `captureStream()`：4K30 與 4K60 的 HEVC 片源，`getVideoPlaybackQuality().droppedVideoFrames` 都在 1% 以下，負擔主要來自編碼。

### 2. 降級策略（H.264 4K，30 Mbps，單一收看者）

Chrome 的頻寬估計從低值開始往上爬。在 loopback 上大約每秒增加 0.7 Mbps，約 30 秒後才到 30 Mbps。這段期間的表現依 `degradationPreference` 不同：

| `degradationPreference` | 前 30 秒 | 30 秒後 |
| --- | --- | --- |
| `maintain-framerate`（現行） | **停在 2560×1440**，`qualityLimitationReason = 'bandwidth'` | 約第 30 秒升到 4K；升上去時 FPS 一度掉到 13 |
| `balanced` | 停在 2560×1440 | 實測 45 秒內仍停在 1440，偶爾到 4K |
| `maintain-resolution` | **第 1 秒起就是 4K**。位元率低時畫面較糊，FPS 維持 30 | 4K30，30 Mbps |

VP9／AV1／H.265 在 `maintain-framerate` 下也是從 540～1440P 開始，要 10～20 秒才升到 4K。

**結論**：維持 `maintain-framerate` 的話，房主選了 4K，收看端前半分鐘只看到 1440P。頻寬不夠時會一直停在 1440P，和畫質面板顯示的不一致。

### 3. 房主負擔：P2P 每位收看者各編一次

P2P 是 mesh，每個 sender 各有一個編碼器。同一條 4K track 送給 N 位收看者，就是 N 路 4K 編碼：

| 測試（H.264，`maintain-resolution`） | 結果 |
| --- | --- |
| 1 人 4K30 | 30 FPS 穩定 |
| 2 人 4K30 | 約 20 秒後 `qualityLimitationReason = 'cpu'`，降到 18～20 FPS |
| 3 人 4K30 | 降到 13～14 FPS（`cpu`） |
| 3 人 1440P30 | 大致 28～30 FPS，偶爾單路降到 19 |
| 1 人 4K60（片源 60 FPS、FPS「原片」、50 Mbps） | 25～43 FPS，不穩 |

> 限制：收看端也在同一台 M1 上解碼，房主端負擔被高估。試過在收看端丟掉影格、不解碼，結果引發 PLI 與關鍵影格風暴，數據不能用，所以只採用上表。結論的方向不受影響：4K 的 P2P 每多一位收看者，就多一路硬體編碼。

### 4. 頻寬與 Cloudflare Realtime

- P2P 總上傳量 = 位元率 × 人數。4K 25 Mbps × 3 人 = 75 Mbps，已超過 60 Mbps 的提醒線（`P2P_TOTAL_BITRATE_WARNING`），一般家用上傳也撐不住。
- 轉發模式：房主只上傳一路、只編碼一次，與人數無關。
- Cloudflare Realtime SFU（[Limits](https://developers.cloudflare.com/realtime/sfu/limits/)、[Pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)）：
  - **文件沒有寫單一 track 或 session 的位元率、解析度上限**，只說 track 數量 "No fixed upper bound. Endpoint and connection capacity impose practical limits"。
  - 支援的影像 codec：H.264、H.265、VP8、VP9、AV1。
  - 計費只算 Cloudflare 送出的流量：每月前 1,000 GB 免費（SFU 與 TURN 共用），之後每 GB 0.05 美元。4K 25 Mbps 約為每位收看者每小時 11 GB；3 人看 2 小時約 68 GB，免費額度大約夠 15 場。
  - 4K 經轉發的實際表現（SFU 是否轉發 25 Mbps 以上、收看端頻寬估計能否爬上去）**尚未實測**，列入第三階段審查與 T-113。

### 5. 收看端解碼（未實測，只能列為風險）

- 送出的是 H.264 4K（level 5.1 等級的資料量），但 Chrome 在 SDP 宣告的 `profile-level-id` 通常是 level 3.1。Mac 收看端實測可以正常硬體解碼。
- Windows（D3D11）與 Android（MediaCodec）能否解 4K H.264，依 GPU 或 SoC 而定，**本機無法驗證**，列入 T-113 人工驗收。沒有 simulcast，收看端無法自行降畫質。這也是「預設維持 1080P、高畫質由房主自己選」的理由。

## 決定

### D1. 解析度檔位

`720`／`900`／`1080`／`1440`／`2160`／`'source'`。

- `1440`、`2160` 沿用「不超過片源」：高於片源高度的檔位停用，房間設定比片源高時以片源高度送出。
- `'source'`（原片）**永遠可選**，不縮放（`scaleResolutionDownBy = 1`）。按鈕與數值顯示實際的片源高度，例如 `原片（1608P）`。寬銀幕 4K 片（3840×1608）的 2160 檔位是停用的，要送全解析度就選「原片」。
- 檔位以高度表示，和現行相同。直式影片不在本 ADR 範圍。

### D2. 位元率檔位

`8`／`10`／`15`／`25`／`40 Mbps`／`'source'`。`SOURCE_BITRATE_MAX` 維持 **50 Mbps**。

- 實測 H.264 4K30 在 30 Mbps 已經沒有頻寬或 CPU 限制。50 Mbps 足以涵蓋 4K60，再往上只會讓上傳先塞爆。
- 不自動連動：選 2160P 時位元率不會自己改。面板提示「4K 建議 25 Mbps 以上」。

### D3. 降級策略（使用者選 A）

依**實際送出高度**決定。實際送出高度 = `min(片源高度, 目標高度)`；`'source'` 時為片源高度。

- **建議 A**：實際送出高度 **> 1080 時用 `maintain-resolution`**，≤ 1080 維持現行的 `maintain-framerate`。
  - 好處：房主選了 4K，收看端第 1 秒起就是 4K，和面板一致。E2E 可以穩定斷言 `frameHeight`。
  - 代價：頻寬或 CPU 不夠時改成掉幀，畫面不會降解析度。需要搭配 D5 的即時提示，讓房主自己調低。
- B：全部維持 `maintain-framerate`。實作最少，但收看端前約 30 秒只有 1440P，頻寬不足時一直停在 1440P，面板顯示的解析度不一定是收看端看到的。E2E 只能等 30 秒以上，容易不穩。
- C：`balanced`。實測 45 秒內幾乎都停在 1440P，不建議。

### D4. Codec

維持 **H.264 優先 → VP8**，高畫質不改用 VP9／AV1／H.265（理由見實測 1、5）。

### D5. 房主負擔與 P2P（使用者選「只提示，不強制」，含即時提示）

- **建議**：**不強制**。延續現行「P2P 總頻寬超過提醒線時提示、不強制」的原則，另外加兩種提示：
  1. **靜態提示**（畫質面板）：實際送出高度 > 1080 時顯示「高畫質需要房主電腦有硬體編碼。P2P 每位收看者各編碼一次，建議改用『轉發』」。在 P2P 模式且有 2 位以上收看者時要更醒目。
  2. **即時提示**（需要擴充傳輸層統計，見 D6）：房主端 video sender 連續 10 秒 `qualityLimitationReason === 'cpu'`，或送出 FPS 低於目標的 70%（`'source'` 以片源 FPS 計），就在畫質按鈕旁提示「房主電腦編碼跟不上，建議調低解析度或改用轉發」。
- 替代方案：P2P 模式下停用 2160 與實際高度超過 1440 的「原片」，由伺服器在 `room:update` 驗證 `mode`＋`quality` 組合。要另外處理「4K 時切回 P2P」該拒絕還是降檔、斷線重連後模式與畫質不一致等時序，複雜度高，不建議。

### D6. 契約變動

1. **`Quality`（protocol.md、`packages/shared/src/schemas/common.ts`）**

   ```ts
   type Quality = {
     height: 720 | 900 | 1080 | 1440 | 2160 | 'source';
     bitrate: 8_000_000 | 10_000_000 | 15_000_000 | 25_000_000 | 40_000_000 | 'source';
     fps: 24 | 30 | 60 | 'source';
   };
   ```

2. **`EncodingTarget.targetHeight: number | null`**，`null` 表示不縮放（「原片」）。傳輸層仍不認識 `'source'`。
   - 不在房間層先把「原片」換成片源高度，原因是：換片時傳輸層會用新 track 的高度、配上舊的目標高度重算縮放（streaming.md §9）。例如從 1080P 片換到 4K 片，若目標高度已被換成 1080，在房間層重新解析之前會先被縮到 1080。
   - `applyVideoEncoding` 依 D3 從 `(sourceHeight, targetHeight)` 算出 `scaleResolutionDownBy` 與 `degradationPreference`。純函式放 `packages/shared`（或 `source-check.ts` 的 `computeScaleDownBy` 旁），p2p／relay 共用。**`p2p/` 不需要改程式**。
3. **房主端 `TransportStats` 加選填欄位**（D5 即時提示用，只在房主本機使用，不進協定）：`frameHeight?`、`framesPerSecond?`、`qualityLimitationReason?: 'none' | 'cpu' | 'bandwidth' | 'other'`。取自 video `outbound-rtp`，缺值就省略。依 ownership.md，傳輸層介面變動需要雙方確認；`p2p/` 若已經用 `common/stats.ts` 取樣，就只需要改 common。
4. **舊版客戶端相容（使用者選升版：`PROTOCOL_VERSION = 2`）**：`qualitySchema` 是 `strictObject` 加 literal。舊分頁收到 `height: 2160` 的 `room:snapshot`／`room:updated` 會解析失敗，`lib/signal.ts` 只 `console.warn` 就丟掉。結果是：
   - 舊版收看者在 4K 房間進房時拿不到 snapshot，停在連線中。
   - 已在房內的舊分頁收不到畫質更新。
   - 伺服器端讀取時一律經過 `parseStoredQuality`，退版時新檔位回到預設畫質，不會壞。
   - **決定**：把 `PROTOCOL_VERSION` 升到 2。舊分頁重新驗證時收到 `4400`，提示「重新整理頁面」，不會卡住。這是「發布前不升版」規則的例外，理由是舊分頁會靜默卡住。
   - 未採用：維持第一版，只在版本紀錄補一句，部署後請大家重新整理。

## 待驗證（第三階段與 T-113）

- 轉發模式送 4K 25～40 Mbps：Cloudflare SFU 是否完整轉發、收看端多久爬到目標位元率。
- Windows Chrome／Edge 房主：H.264 是否有硬體編碼（`encoderImplementation` 只能在測試頁取得）、4K30 能否維持。
- Windows、Android 收看端解 4K H.264 的能力與 CPU 負擔。

## 實測方法（可重現）

1. 用 ffmpeg 產生測試片，例如：

   ```sh
   ffmpeg -f lavfi -i "testsrc2=size=3840x2160:rate=30,noise=alls=12:allf=t" -f lavfi -i "sine=f=440:sample_rate=48000" -t 20 -c:v hevc_videotoolbox -b:v 30M -tag:v hvc1 -c:a aac hevc-2160p30.mp4
   ```

2. 用支援 Range 的本機靜態伺服器提供測試片。Playwright `route.fulfill` 交出 90 MB 的片會讓頁面當掉。
3. 在 Playwright Chrome（`channel: 'chrome'`）的同一頁做 loopback，記錄 `outbound-rtp` 的 `encoderImplementation`、`frameWidth`／`frameHeight`、`framesPerSecond`、`qualityLimitationReason`、`qualityLimitationDurations`，以及 `inbound-rtp` 的 `frameHeight`、`decoderImplementation`。另外以 `ps` 取樣 Chrome 程序的 CPU。

## 審查補充（2026-11-26）

### D7. 10-bit 片源的轉換畫布用原片尺寸（使用者同意）

BUG-004 原本規定 10-bit 轉 8-bit 的畫布高度取 `min(videoHeight, RESOLUTION_STEPS 的最大值)`，也就是 1080。T-136 之後最大檔位是 `'source'`，這條規則失效，而且 10-bit 4K 片會被固定縮到 1080，`2160P`／`原片` 沒有作用。

改為：**畫布與原片同尺寸，轉換只負責 10-bit 轉 8-bit，縮放仍由傳輸層的 `scaleResolutionDownBy` 處理**。

實測（M1、Chrome 158，HEVC Main 10 3840×2160 30 fps，畫布 3840×2160，H.264 `maintain-resolution` 30 Mbps）：

- 房主分頁沒有崩潰，收看端 40 秒內維持 3840×2160 @ 29～30。
- 轉換每張畫面平均 0.2 ms，與 1080 畫布相同。
- Chrome 總 CPU 與直接送 8-bit 4K 同一量級。

未採用的方案：

- 上限設為 2160：8K 片的「原片」就不是真的原片。
- 畫布跟著目前送出高度變：直播中 track 尺寸會改變，與 BUG-004「track 物件不變」的設計衝突。

### 實際開播驗證（Neon 實作分支）

在 Chrome 158 以應用程式實際操作：

- HEVC 3840×2160 30 fps 片源，選 `2160P`、25 Mbps，P2P 兩位收看者。
- 兩位收看端 `inbound-rtp` 都是 3840×2160，畫質按鈕顯示 `2160P`，和面板一致。
- 房主兩路編碼受 CPU 限制，降到 13～21 FPS。開播約 20 秒後出現「編碼跟不上」提示，符合 streaming.md §2 的連續 10 秒條件。
- H.264 SDP 的 `profile-level-id` 仍是 `42001f`（level 3.1），Mac 收看端解 4K 正常。Windows、Android 仍待 T-113。
