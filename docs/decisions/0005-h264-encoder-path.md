# ADR 0005：Chrome 收看端位元率偏低的根因與「Safari 模式」

- 狀態：已採用（T-139 第二部分，使用者指定「Safari 模式」開關）
- 日期：2026-11-27
- 相關：streaming.md §2「頻寬估計」「Safari 模式」、§3、§4；ADR 0004（高畫質）

## 背景

T-139 第一部分讓 Safari 收看者也走房主的硬體編碼（`42001f`→VideoToolbox），解決了「Safari 比 Chrome 高 2 倍」的分歧。使用者實測發現：沒有 Safari 加入時，Chrome 收看端畫質也偏低、位元率衝不上去。第一部分的證據表同時有兩筆看似矛盾的資料：Chrome 硬體編碼約 3.4 Mbps（QP≈22），雙 Chrome 控制組卻有 7.9 Mbps。

## 量測方法

- 環境：Apple M1、macOS 27.2.1、Google Chrome 158.0.8127.88（Playwright `channel: 'chrome'`、非 headless），本機 loopback。
- 片源（真實長片，取 150 秒動作段，音軌轉 AAC）：Blender 開放電影 *Tears of Steel*（ToS，實拍＋特效，1920×800 24 fps H.264 Main，約 6.4 Mbps）、*Big Buck Bunny*（BBB，動畫，1080p30 約 3.6 Mbps、2160p30 約 9.3 Mbps）。另加 `bug004-evidence/media/4k-main10.mp4`（HEVC Main 10，經 §1 的 10-bit 轉換）、舊 fixture `h264-2160p-aac.mp4`（`testsrc2` crf 45）與雜訊合成片（`testsrc2`＋`noise=alls=12`）。
- 編碼路徑照房主端：一次 `captureStream()`，N 條 sendonly 連線，`setCodecPreferences`、`maxBitrate`／`maxFramerate`／`scaleResolutionDownBy`／`degradationPreference`、`contentHint='motion'`。頁面先取得假鏡頭權限，`getStats()` 才提供 `encoderImplementation`。
- 每格暖機 20 秒、量 60 秒穩態，每秒取樣：`outbound-rtp`（`targetBitrate`、bytesSent、`encoderImplementation`、`powerEfficientEncoder`、`qpSum/framesEncoded`、`qualityLimitationReason`／durations、`framesPerSecond`、`frameWidth/Height`、`hugeFramesSent`）、`candidate-pair.availableOutgoingBitrate`、`getParameters()`、track 的 `contentHint`、`media-source` 每秒影格數，以及 `<video>` 的 `requestVideoFrameCallback` 每秒新畫面數。CPU 取 Chrome 全部程序加總（單核 100%）。
- 量測腳本與原始資料：見 T-139 交接備註（scratchpad 的 `bench/run.mjs`、`page.js`）。

## 取證結果

### 1. 編碼路徑與片源（預設路徑＝`42001f`／VideoToolbox；「OpenH264」＝`42e01f`，即 Safari 模式）

| 片源／設定／人數 | 編碼器 | 實際 Mbps | target | 可用頻寬 | avgQp | 解析度@fps | 擷取 fps（畫面） | 受限 | CPU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ToS 1080P／8M ×1 | VideoToolbox | 7.8 | 8.0 | 14.7 | 23 | 1920×800@30 | 30 | none | 54% |
| ToS 1080P／8M ×1 OpenH264 | OpenH264 | 7.7 | 8.0 | 13.9 | 22.9 | 1920×800@30 | 30 | none | 83% |
| ToS 1080P／15M ×1 | VideoToolbox | 13.8 | 15.0 | 27.8 | 17.7 | 1920×800@30 | 30 | none | 52% |
| ToS 1080P／15M ×1 OpenH264 | OpenH264 | 14.1 | 14.8 | 26.9 | 17.7 | 1920×800@30 | 30 | none | 91% |
| ToS 1080P／8M ×2 | VideoToolbox | 7.8／7.8 | 8.0 | 14.7 | 22.8／22.8 | 1920×800@30／30 | 30（24） | none | 78% |
| ToS 1080P／15M ×2 | VideoToolbox | 13.8／13.8 | 15.0 | 28.1 | 17.7／17.7 | 1920×800@30／30 | 30（24） | none | 85% |
| ToS 1080P／15M ×2 OpenH264 | OpenH264 | 13.8／13.8 | 14.8 | 26.5 | 17.2／17.3 | 1920×800@30／30 | 30（24） | none | 176% |
| BBB 1080P／8M ×1 | VideoToolbox | 6.3 | 8.0 | 14.4 | 20.3 | 1920×1080@30 | 30（30） | none | 58% |
| BBB 1080P／8M ×1 OpenH264 | OpenH264 | 6.3 | 8.0 | 13.6 | 18 | 1920×1080@30 | 30（30） | bandwidth 2s | 68% |
| BBB 1080P／15M ×1 | VideoToolbox | 9.1 | 15.0 | 25.7 | 17.5 | 1920×1080@30 | 30（30） | none | 62% |
| BBB 1080P／15M ×1 OpenH264 | OpenH264 | 8.9 | 14.7 | 22.8 | 15.2 | 1920×1080@29 | 30（30） | none | 72% |
| BBB 1080P／8M ×2 | VideoToolbox | 6.3／6.3 | 8.0 | 14.5 | 20.3／20.3 | 1920×1080@30／30 | 30（30） | none | 78% |
| BBB 1080P／8M ×2 OpenH264 | OpenH264 | 6.3／6.3 | 8.0 | 13.6 | 17.9／17.9 | 1920×1080@30／30 | 30（30） | bandwidth 2s | 126% |
| BBB 1080P／15M ×2 | VideoToolbox | 8.8／9.1 | 14.7 | 24.2 | 17.6／17.5 | 1920×1080@30／30 | 30（30） | none | 82% |
| BBB 4K→1080P／8M ×1 | VideoToolbox | 6.8 | 8.0 | 14.8 | 20.8 | 1920×1080@30 | 30（30） | none | 62% |
| BBB 4K→1080P／8M ×1 OpenH264 | OpenH264 | 6.6 | 8.0 | 13.6 | 18.5 | 1920×1080@30 | 30（30） | bandwidth 1s | 72% |
| BBB 4K→1080P／8M ×2 | VideoToolbox | 6.8／6.8 | 8.0 | 14.6 | 21／21 | 1920×1080@30／30 | 30（30） | none | 81% |
| BBB 4K→1080P／15M ×1 | VideoToolbox | 10.1 | 15.0 | 26.6 | 17.9 | 1920×1080@30 | 30（30） | none | 65% |
| BBB 2160P／25M ×1 | VideoToolbox | 17.0 | 21.8 | 37.2 | 21.6 | 3840×2160@30 | 30（30） | none | 85% |
| BBB 2160P／25M ×1 OpenH264 | OpenH264 | 8.7 | 14.8 | 16.9 | 24.3 | 3840×2160@10 | 13.4（30） | bandwidth 8s、cpu 48s | 82% |
| BBB 2160P／25M ×2 | VideoToolbox | 12.8／12.8 | 21.1 | 33.5 | 22.9／22.9 | 3840×2160@18／18 | 17.7（30） | cpu 50s | 101% |
| Main 10 4K（10-bit 轉換）2160P／25M ×1 | VideoToolbox | 22.8 | 22.9 | 38.5 | 24 | 3840×2160@30 | 30（23.4） | none | 87% |
| Main 10 4K（10-bit 轉換）1080P／8M ×1 | VideoToolbox | 7.1 | 8.0 | 12.7 | 20 | 1920×1080@30 | 30（23.4） | none | 63% |
| 舊 fixture h264-2160p-aac 1080P／8M | VideoToolbox | 5.0 | 7.8 | 9.0 | 17.5 | 1920×1080@30 | 30（29.3） | none | 60% |
| 舊 fixture 1080P／8M OpenH264 | OpenH264 | 6.4 | 8.0 | 11.9 | 12.1 | 1920×1080@30 | 30（29.3） | none | 48% |
| 雜訊合成片 1080P／8M | VideoToolbox | 8.0 | 8.0 | 13.8 | 28.7 | 1920×1080@30 | 30（30） | none | 60% |
| 雜訊合成片 1080P／8M OpenH264 | OpenH264 | 8.0 | 8.0 | 13.7 | 29.9 | 1920×1080@30 | 30（30） | bandwidth 2s | 67% |

`powerEfficientEncoder`：VideoToolbox 全為 `true`，OpenH264 全為 `false`。`getParameters()` 的 `maxBitrate`、`scaleResolutionDownBy`、`degradationPreference` 與 track 的 `contentHint` 全數與設定相同。

### 2. 對照組（ToS 1080P／8M ×1，除非另註）

| 變體 | 編碼器 | 實際 Mbps | target | 可用頻寬 | avgQp | 解析度@fps | 擷取 fps | 受限 | CPU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Main 4d001f（VideoToolbox） | VideoToolbox | 7.8 | 8.0 | 14.5 | 21.7 | 1920×800@30 | 30 | none | 52% |
| High 64001f（VideoToolbox） | VideoToolbox | 7.8 | 8.0 | 14.3 | 21.7 | 1920×800@30 | 30 | none | 54% |
| VP9（libvpx） | libvpx | 8.0 | 7.9 | 15.7 | 76.6 | 1920×800@30 | 30 | none | 120% |
| AV1（libaom） | libaom | 7.6 | 8.0 | 15.6 | 67 | 1920×800@30 | 30 | none | 143% |
| VP8（libvpx） | libvpx | 8.0 | 7.9 | 15.3 | 24.2 | 1920×800@30 | 30 | none | 86% |
| contentHint '' | VideoToolbox | 7.8 | 8.0 | 14.5 | 22.9 | 1920×800@30 | 30 | none | 53% |
| contentHint 'detail' | VideoToolbox | 7.3 | 7.4 | 10.4 | 23.5 | 1920×800@30 | 30 | none | 51% |
| degradationPreference maintain-resolution | VideoToolbox | 7.8 | 8.0 | 14.5 | 22.8 | 1920×800@30 | 30 | none | 53% |
| BBB High 64001f | VideoToolbox | 6.0 | 8.0 | 14.2 | 19.7 | 1920×1080@30 | 30（30） | none | 57% |
| BBB VP9 | libvpx | 8.0 | 7.9 | 15.5 | 58.8 | 1920×1080@30 | 30（30） | none | 97% |

（QP 的尺度依 codec 不同：H.264 0～51、VP9／AV1 0～255，不能跨 codec 比較。）

### 3. App 內的頻寬估計（房主與收看者在不同分頁，有音軌）

單頁 loopback（只有影像）時，可用頻寬平滑爬升到約 14 Mbps。**App 內**的估計卻約每 5 秒下降 15～25%，期間沒有遺失、NACK、PLI，房主與收看端也沒有主執行緒卡頓或 `setParameters`。以兩分頁最小重現逐一排除：

| 兩分頁重現（15 Mbps 上限，BBB 1080P） | 30 秒內的估計 |
| --- | --- |
| 只有影像（同／不同 context） | 平滑爬升，30 秒約 9～11 Mbps，沒有下降 |
| 影像＋音軌（同／不同 context） | 每 5 秒掉 15～25%，30 秒約 10 Mbps |
| 影像＋音軌，房主套用的 answer 拿掉**音訊**的 transport-cc | 平滑爬升，22 秒到 15 Mbps |
| 影像＋音軌，只加 `x-google-start-bitrate=7500` | 仍每 5 秒下降 |

App 內修正前後（房主 `targetBitrate`，一位 Chrome 收看者）：

| 片源／設定 | 修正前 | 修正後 |
| --- | --- | --- |
| BBB 1080P／8M | 13 秒到 8M，14、23 秒掉到 6.6M | 13 秒到 8M 後維持 |
| ToS 1080P／15M | 30 秒到 15M，之後掉到 10.5～11.2M | 21 秒到 15M 後維持 |
| BBB 2160P（原片）／25M | 約 45 秒到 25M | 約 31 秒到 25M 後維持 |

`x-google-start-bitrate`（起始頻寬提示）在 app 內前後完全相同：有音軌時估計本來就從約 5.5 Mbps 起跳，所以不採用。

## 結論（逐一假設）

- **矛盾的解釋**：第一部分的兩筆資料是**不同片源**。3.4 Mbps 是 `h264-2160p-aac.mp4`（`testsrc2` crf 45，幾乎靜態、極好壓），7.9 Mbps 是雜訊合成片（極難壓）。位元率是上限不是目標，編碼器只用畫面需要的位元。本次同樣兩片：fixture 5.0 Mbps（QP 17.5）、雜訊片 8.0 Mbps（QP 28.7）。
- **(a) VideoToolbox 用不滿**：部分成立。好壓的片源（BBB、fixture）兩種編碼器都用不滿（BBB 8M 都只送 6.3M、15M 都只送約 9M），所以「用不滿」不是 VideoToolbox 獨有；但同樣位元率下 OpenH264 的 QP 較低（BBB 18.0 vs 20.3、15.2 vs 17.5；fixture 12.1 vs 17.5），細節略多。難壓的實拍片（ToS）兩者都吃滿、QP 相同。QP 不是跨編碼器的畫質指標，實際觀感交給使用者以 Safari 模式比較。
- **(b) 頻寬估計爬升慢或卡住**：**成立，是 app 內「衝不上去」的主因**。音訊帶 transport-cc 時估計每 5 秒被打下來，15M 撐不住、4K 要 45 秒。修正見下方 D1。
- **(c) 參數沒套用**：排除，`getParameters()` 全數相符。
- **(d) contentHint**：排除。`''` 與 `'motion'` 相同；`'detail'` 讓可用頻寬變低（10.4 vs 14.5），位元率反而少 7%。
- **(e) 擷取端**：排除。`media-source` 每秒 30 格、播放端畫面數與片源相同（24 fps 片源會重複送到 30 格，重複格幾乎不佔位元）；10-bit 轉換路徑 4K 照樣吃滿 22.8 Mbps。4K 兩人時擷取端只剩 17.7 格，是 WebRTC 因 `cpu` 受限而丟格，不是擷取問題。
- **(f) 其他 codec**：VP9、AV1、VP8 都能吃滿 8M，但 CPU 是硬體 H.264 的 1.6～2.6 倍，且 ADR 0004 的結論不變（收看端相容性、4K 負擔）。Main／High profile 在 VideoToolbox 上位元率相同、QP 低約 1.3，但 Safari／部分收看端不收，不採用。
- 兩位收看者在 1080P 下與一位完全相同（各自吃滿或各自同樣用不滿），沒有分配不公。

## 決定

### D1. 音訊不參與 transport-cc（修正 b）

房主在本機套用對端 answer 前，以 `withoutAudioTransportCc()` 拿掉 audio m-section 的 transport-cc 回饋與 transport-wide-cc 標頭擴充（P2P 每份 answer，含 ICE restart 與重新協商；轉發的 WHIP answer）。只改房主本機字串，不送出、不動 video、不動收看端與伺服器。音訊照樣以 Opus 128 kbps 送出。

- 代價／風險：音訊不再計入 transport-cc 估計（音訊只佔 128 kbps，影響可忽略）。真實網路與 Cloudflare Realtime 上的效果沒有實測，列入 T-113。

### D2. Safari 模式（使用者要求的開關）

畫質面板內的「Safari 模式」開關，開啟後對所有收看者改走 Constrained Baseline `42e0xx`（macOS Chrome 上為 OpenH264）。直播中切換：P2P 在同一條連線重新協商，轉發以 `encodings[].codec` 在已協商的 codec 間切換（WHIP 不能重新協商）。規則見 streaming.md §2。

| | 預設（硬體 VideoToolbox） | Safari 模式（軟體 OpenH264） |
| --- | --- | --- |
| 實拍片 1080P | 吃滿 8／15M，QP 23／17.7 | 相同 |
| 動畫／好壓的片 1080P | 6.3M，QP 20.3 | 6.3M，QP 18.0（細節略多） |
| CPU（1080P 1 人／2 人） | 54～62%／78～85% | 68～91%／126～176% |
| 4K 1 人 | 3840×2160@30 | 約 10 fps（`cpu` 受限） |

- Windows（MediaFoundation／NVENC 等）：依 Chromium 的硬體編碼器 SDP 宣告方式，`42e0xx` 同樣由 OpenH264 處理，預期意義相同；本機無法實測，列入 T-113。
- 預設關閉，只在房主本機，不進協定。

### 未採用

- 換成 VP9／AV1：CPU 高、收看端相容性差（ADR 0004）。
- Main／High profile：Safari 收看端不收，需要另一套逐人映射。
- `x-google-start-bitrate`：app 內沒有效果。
- 調高 `maxBitrate` 讓 VideoToolbox「用滿」：位元率由片源決定，兩種編碼器都一樣，調高上限只會讓難壓的片佔更多上傳。
