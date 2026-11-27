# ADR 0007 附錄 A：實驗與查證（T-140）

- 環境：Apple M1、macOS、Google Chrome 158（Playwright `channel: 'chrome'`、非 headless），2026-11-27。
- 原型與量測腳本：`docs/decisions/assets/0007/`（用法見該資料夾 README）；原始結果 JSON 在其中的 `results/`。種子式散布的原型與結果在附錄 E §3。
- 限制：房主與兩位收看者在**同一台機器、同一個 Chrome**，走 loopback；收看端解碼也佔用同一顆 GPU。真實網路（RTT、掉包、跨境）、Windows／Android／iOS 收看端都沒有在本機驗證，列入 T-113。

## §1 原片直送（第一層）

**片源**（ffmpeg 產生，`testsrc2`＋時間雜訊，難壓縮；另有一支真實 4K 素材循環）：

| 代號 | 容器／編碼 | 解析度 | 平均位元率 | GOP |
| --- | --- | --- | --- | --- |
| 1080P | MP4、H.264 High、B 幀 3、AAC | 1920×1080 24 fps，120 秒 | 8.2 Mbps | 最長 10 秒 |
| 4K MKV | MKV、HEVC Main（VideoToolbox）、AAC | 3840×2160 24 fps，90 秒 | 40.3 Mbps | 5 秒 |
| 4K Main 10 | MP4、HEVC Main 10、AAC | 3840×2160 24 fps，60 秒 | 30.5 Mbps | 5 秒 |
| 4K 實拍 | MP4 `hvc1`（`bug004-evidence/media/4k-main8.mp4` 循環 15 次） | 3840×2160 24 fps，60 秒 | 12.3 Mbps | 約 4 秒 |

**流程**（`run-passthrough.mjs`）：房主開播 → 3 秒後收看者 A 加入 → 8 秒時 B 加入 → 量 20 秒穩態 → 房主往後跳 25 秒（4K 片為 13 秒）→ 10 秒後往回跳 15 秒 → 10 秒後暫停 3 秒、繼續 → 量 10 秒。參數：總預算 100 Mbps、平常 1.5 倍、追趕 6 倍、超前 20 秒、分塊 64 KiB。

**同步誤差的算法**：雙方都用 `requestVideoFrameCallback` 記錄每張畫面的（`expectedDisplayTime`, `mediaTime`）。對收看端每張畫面，以房主最近一張畫面往後推算同一時刻的媒體時間，取差值。同一台機器的時鐘相同，所以這是畫面上的誤差（解析度受螢幕更新率限制，約 8～17 ms）。

**量測的界線**（GPT 審查指出）：

- 只統計有回呼的畫面；與參考畫面相隔超過 100 ms 的樣本略過，所以**沒有畫面的時段（卡住）不在 p95 內**。
- 「穩態」從 B 加入後 4 秒開始量 20 秒；「事件後」從暫停恢復後 8 秒才開始量 10 秒，不含恢復過程。
- 「跳轉恢復」是從收看端收到新 epoch 起，到它自己估計的誤差第一次 < 100 ms 的時間。
- `expectedDisplayTime` 是瀏覽器的預估值，不是實際上螢幕的時間。
- 測試片都是固定幀率、封閉 GOP（x264 預設、VideoToolbox）。原型封裝器在 VFR＋open GOP 會算錯 DTS（附錄 B §3），**表中數字不代表那類片源**。
- 原始 JSON 在 `docs/decisions/assets/0007/results/`。

**結果**（最終版原型，`final7`）：

| 片源 | 加入→開播（A／B） | 穩態與房主誤差 p50／p95（A；B） | 收看者之間 p95 | 往後跳→誤差 < 100 ms（A／B） | 往回跳（A／B） | 事件後誤差 p95 | 掉幀 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1080P 8 Mbps | 1.27／1.73 秒 | 33／50；33／50 ms | 25 ms | 1.1／1.1 秒 | 3.4／3.6 秒 | 33～34 ms | 0／1,500 格 |
| 4K MKV 40 Mbps | 1.86／2.05 秒 | 15／18；33／51 ms | 34 ms | 3.0／3.1 秒 | 3.0／2.9 秒 | 10～11 ms | 1／1,450 格 |
| 4K Main 10 30 Mbps | 2.41／1.97 秒 | 33／50；33／50 ms | 18 ms | 6.4／4.9 秒 | 1.9／1.9 秒 | 35～50 ms | 3～4／1,400 格 |
| 4K 實拍 12 Mbps | 1.20／0.71 秒 | 33／50；9／34 ms | 36 ms | 4.2／4.3 秒 | 3.2／3.2 秒 | 35～48 ms | 0～3／1,450 格 |

- **GPT 複跑**（摘要，原始 JSON 未收錄；另生成 120 秒 1080P 8.24 Mbps CBR 樣片）：加入 0.72／0.45 秒；穩態 p50／p95 18.5／49.8、17.4／48.3 ms；收看者之間 p95 25.1 ms；往後、往回跳後 < 100 ms 為 0.97～1.13 秒。與上表同一量級。
- 兩位收看者都沒有遇到 `QuotaExceededError`；收看端緩衝維持在「已播 10 秒＋超前約 20 秒」。
- 穩態誤差約有 −17～−33 ms 的固定偏差（收看端稍慢），可在正式版以初次對時校正。
- 4K Main 10 往後跳較慢：10-bit 4K 跳轉需要較長的解碼時間，第一次跳轉的提前量估得不夠，要多跳一兩次。

**原型踩到、已寫進 ADR 規則的問題**（每一項都有修正前後的量測紀錄）：

1. 收看端第一次換 epoch 時把還在佇列的 init segment 一起清掉 → 一位收看者永遠收不到畫面。原型的修法是依 config 保留 init；正式草稿也改為收看端依 config 快取 init、每次重設後自己重新附加（附錄 F §2）。
2. 爆量送出 → SCTP 停滯 2～30 秒以上（§2）。改為配速。
3. 用收看者回報的 `currentTime` 算超前量 → 跳轉後誤用慢速配速，加入要 11 秒。改用房主媒體時間後降到 1.3～2.0 秒。
4. 跳轉後舊位置 `readyState` 停在 2，判斷順序錯誤 → 收看端永遠不跳轉。
5. 清緩衝以 `currentTime` 為準 → 往回跳後把剛收到的資料清掉（附錄 C §4）。
6. 只從前一個關鍵影格開始送 → 4K 40 Mbps 加入 17 秒、跳轉 >10 秒。改為入口估算後 1.8 秒、約 3 秒（原型用的是舊公式，正式公式見附錄 C §3）。
7. 只用 `currentTime` 對時 → 20～50 ms 固定偏差；改用已顯示畫面時間。只用 ±5% 調速 → 跳轉後要 7～15 秒才收斂；原型改用簡化規則（落後 ≥ 300 ms 跳轉、超前 ≥ 80 ms 暫停等待、以 `currentTime` 判斷而非可取消的工作）後 1～6 秒。附錄 C §2 是在這組規則上補齊優先順序、取消與逾時的正式草稿，**尚未實測**。

**格式涵蓋**（`run-formats.mjs`，拆檔 → fMP4 → MSE，播 1.5 秒）：`e2e/fixtures/` 的 `h264-aac.mp4`、`h264-silent.mp4`、`hevc-aac.mp4`、`hevc-hev1-aac.mp4`、`hevc-aac.mkv`、`hevc-main10-aac.mp4`、`hevc-main10-aac.mkv`、`h264-2160p-aac.mp4` 全部可以附加並播放、畫面前進。mediabunny 對這些 HEVC 片一律回報 `hev1.*` 的 codec 字串（包括 `hvc1` 片源）。另做的 `h264-ac3-20s.mkv`：影像可以，AC-3 音訊 MSE 與 WebCodecs 都不支援。

## §2 DataChannel 吞吐與背壓（`run-dc-bench.mjs`，原始輸出 `results/dc-bench.txt`）

房主分頁對每位收看者盡量送 64 KiB 訊息（或依速率配速），量 20 秒；「最低 0.5 秒窗」是收看端每 0.5 秒收到量換算的最小值，接近 0 代表停滯。

| 設定 | 收看人數 | 每人 Mbps | 最低 0.5 秒窗 |
| --- | --- | --- | --- |
| 不配速，分塊 64 KiB，高水位 1 MiB | 1 | 210 | 1 Mbps（停滯） |
| 同上 | 2 | 78／132 | 1 Mbps（停滯） |
| 不配速，分塊 16 KiB | 1／2 | 215／110＋85 | 41／0.5 Mbps |
| 不配速，分塊 256 KiB，高水位 4 MiB | 1／2 | 222／125＋91 | 46／4 Mbps |
| 不配速，高水位 256 KiB | 1／2 | 178／114＋72 | 2／1 Mbps |
| 配速 12 Mbps | 1／2／3 | 12 | 11.5 Mbps（平順） |
| 配速 50 Mbps | 1／2 | 50 | 48～49 Mbps（平順） |
| 配速 50 Mbps | 3 | 50 | 0～23 Mbps（停滯） |
| 配速 100 Mbps | 1／2 | 100／78＋94 | 99／1 Mbps |

結論：分塊大小與高水位都救不了爆量；**配速**能讓短窗吞吐穩定。同一台機器總量超過約 150 Mbps 時本次量到停滯；原型在 4K 40 Mbps 追趕時曾用 6 倍（每人 240 Mbps），兩位收看者都停滯超過 40 秒，加上總預算後才正常。

GPT 複跑（摘要；原始輸出在審查者環境，未收錄）：配速 50 Mbps × 2 最低窗 48.1～49.1 Mbps（一致）；不配速 64 KiB × 2 平均 119／94 Mbps、最低窗 1.0～3.1 Mbps，**四次都沒有低於 0.5 Mbps 的窗**。所以「爆量會長時間停滯」與「約 150 Mbps 臨界」只在本次重現，成因（掉包後重傳逾時，或其他）未確認，列為待驗。另外 `bufferedAmount` 不降只代表 SCTP 沒送出，不能區分是網路、對端接收或對端 JS 處理慢；正式版要把房主 `bufferedAmount`、收看端收到速率、收看端附加速率分開記錄（附錄 C §4）。

## §3 第二層轉碼與 WebRTC 對照（`encoder-lab.html`，與 Windows 實驗頁是同一頁）

WebCodecs：mediabunny 取封包 → `VideoDecoder` → `OffscreenCanvas` 縮到 1080P → `VideoEncoder`（`avc1.640028`、`bitrateMode: 'variable'`、Annex B），每 2 秒一個關鍵影格，取片中 30 秒盡快跑。QP 是解析 slice header 得到的每張畫面基本 QP（與 WebRTC `qpSum` 的算法相同）。WebRTC：與房主端同一條路（`<video>` → `captureStream()` → H.264），loopback 40 秒，取第 13 秒之後的穩態。

| 片源 → 1080P | 目標 | WebCodecs quality（硬體） | realtime（硬體） | quality（軟體） | WebRTC VideoToolbox | WebRTC OpenH264（Safari 模式） |
| --- | --- | --- | --- | --- | --- | --- |
| 4K MKV 40 Mbps | 8 Mbps | 6.8 倍速，7.79 Mbps，QP 20.6 | 4.5 倍，7.88，20.9 | 5.5 倍，7.99，23.5 | 7.99，QP 22.2 | 7.90，23.0 |
| 4K MKV 40 Mbps | 15 Mbps | 6.8 倍，14.58，17.9 | 4.3 倍，15.01，16.5 | 6.1 倍，14.93，16.9 | 13.65，18.3 | 13.37，18.6 |
| 4K Main 10 30 Mbps | 8 Mbps | 6.8 倍，7.78，20.9 | 4.5 倍，7.90，19.9 | 6.6 倍，7.97，19.7 | 8.00，19.8 | 7.73，18.4 |
| 1080P 8 Mbps（不縮放） | 8 Mbps | 8.1 倍，8.05，25.1 | 4.6 倍，7.95，24.1 | 6.8 倍，7.98，25.2 | 7.89，25.8 | 7.88，26.5 |

- 所有 WebCodecs 設定的輸出時間戳都依序：**未觀察到輸出重排**（即沒有 B 幀的跡象；這只能說明本次輸出，不是規格保證）。`hardwareAcceleration: 'prefer-hardware'` 只是偏好，WebCodecs 不回報實際用的是不是硬體。
- WebRTC 的 `encoderImplementation` 只在頁面「正在擷取」時才提供：權限串流拿到後立刻停掉就讀不到，要保持開啟到測完（實驗頁已處理）。
- Main 10 片源直接 `captureStream()` 交給 WebRTC 會讓分頁崩潰（BUG-004，實驗頁第一次跑就崩潰）；實驗頁比照房主端先經畫布轉成 8-bit。
- WebRTC 從 0 爬到 8 Mbps 約 14 秒（只有影像的 loopback）。

**應急方案 A 的對照**（4K MKV → 1080P，選 8 Mbps）：`maxBitrate` 放大成 12 Mbps，SDP 加 `x-google-min-bitrate=8000;x-google-start-bitrate=8000`。VideoToolbox 實送 11.92 Mbps、QP 19.2，第 1 秒就有 7.3 Mbps（不加時第 1 秒只有 0.05 Mbps）。在 M1 上它等於把位元率調高 1.5 倍，沒有額外的好處；NVENC 是否不同要看 Windows 結果。

## §4 跨瀏覽器能力（查證日期 2026-11-27）

| 項目 | Chrome 桌面 | Android Chrome | Safari macOS | iOS Safari | Firefox |
| --- | --- | --- | --- | --- | --- |
| MSE | 有 | 有（caniuse 列 157 起） | 8 起 | iPhone 的傳統 MSE：caniuse 列「部分」；**ManagedMediaSource** iPad／Mac 17.0、iPhone 17.1 起 | 42 起 |
| ManagedMediaSource | 無（Blink `mediasource/` 無此檔，本機 `'ManagedMediaSource' in window` 為 false） | 未查證 | 有 | 有 | 未查證 |
| WebCodecs | 有 | 有 | 16.4～18.7 部分，26 起完整 | 同 macOS | 桌面 130 起；Android 無 |
| HEVC（MSE） | 107 起，需平台硬體（Win 8+、macOS 11+、Linux VAAPI），8-bit；本機 `hvc1`、`hev1`、Main 10 都 true | 依硬體；Main 10 依晶片 | 13 起 | 11 起 | Windows 限定，需 HEVC 擴充 |
| AC-3／E-AC-3（MSE） | 否（本機 false；Chromium 只在 Cast／tvOS 開） | 否 | 未查證 | 未查證 | 未查證 |
| DTS（MSE） | 否（`enable_platform_dts_audio = false`） | 否 | 未查證 | 未查證 | 未查證 |
| Opus／FLAC in MP4（MSE） | 是（本機） | 未查證 | 未查證 | 未查證 | 未查證 |

補充：

- iOS ManagedMediaSource 必須設 `video.disableRemotePlayback = true` 或提供 AirPlay 替代來源，否則 `sourceopen` 不會觸發；瀏覽器可隨時清掉緩衝，要依 `startstreaming`／`endstreaming` 決定何時送資料（MDN）。
- Safari 對 `hev1` 的支援沒有官方文件；StaZhu 的整理指出 Apple 播放器不收 `hev1`，所以 Safari 收看者另用一個 `hvc1` config（逐樣本剝除與 `hvcC` 相同的參數集）；做不到時才走第二或第三層（附錄 B §5）。
- Chrome 的 MSE 記憶體上限：影像 150 MiB、音訊 12 MiB（`demuxer_memory_limit.h`），Android 低記憶體裝置更低（影像 15～30 MiB）。Android 收看端的超前量要依 `QuotaExceededError` 自動縮小。
- Chrome 的 MediaSource 在任一 SourceBuffer 收到 init segment 後就不能再加新的 SourceBuffer（本機錯誤訊息：「reached the limit of SourceBuffer objects」）。影音兩個 SourceBuffer 要先一起建立。
- `file://` 頁面在 Chrome 是安全環境（`isSecureContext === true`），WebCodecs、WebRTC、從 CDN 載入 ES module 都可以用（本機實測）。

來源：
[MDN ManagedMediaSource](https://developer.mozilla.org/en-US/docs/Web/API/ManagedMediaSource)、
[MDN WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)、
[MDN VideoEncoder.configure](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder/configure)、
[W3C WebCodecs latencyMode](https://w3c.github.io/webcodecs/#dom-videoencoderconfig-latencymode)、
[WebKit：Safari 17.1](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/)、
[caniuse MSE](https://caniuse.com/mediasource)、[caniuse HEVC](https://caniuse.com/hevc)、[caniuse WebCodecs](https://caniuse.com/webcodecs)、
[StaZhu／enable-chromium-hevc-hardware-decoding](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding)、
Chromium 原始碼 [`media/base/mime_util_internal.cc`](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/mime_util_internal.cc)、[`media/media_options.gni`](https://chromium.googlesource.com/chromium/src/+/HEAD/media/media_options.gni)、[`media/base/supported_types.cc`](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/supported_types.cc)、[`media/base/demuxer_memory_limit.h`](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/demuxer_memory_limit.h)。

W3C 規格對 `latencyMode: 'quality'` 只說「SHOULD optimize for encoding quality」「MAY increase encoding latency」「MUST not drop frames」，**沒有保證會用 B 幀**，與本機實測（無 B 幀）一致。

## §5 拆檔套件比較（npm，2026-11-27）

| 套件 | 版本／最後更新 | 授權 | MP4 | MKV | 備註 |
| --- | --- | --- | --- | --- | --- |
| **mediabunny** | 1.66.5（2026-11-26）；採用 1.65.2（2026-11-04，超過 14 天） | MPL-2.0 | ✓ | ✓ | 純 TS、無執行期相依；完整 bundle 壓縮後約 187 KB，可 tree-shake；可取關鍵影格、依時間定位；有 AC-3 WASM 擴充 `@mediabunny/ac3`（1.65.2，約 5.6 MB） |
| mp4box.js | 2.6.0（2026-11-20） | BSD-3 | ✓ | ✗ | 成熟，能直接切 fMP4；MKV 要另找 |
| ebml | 3.0.0（2022） | MIT | — | 只有 EBML 解析 | 久未更新 |
| ts-ebml | 3.0.2（2025-09） | MIT | — | EBML 解析 | 要自己組 Matroska 語意 |
| jswebm／matroska | 0.1.2／2.2.5（2022） | — | — | 部分 | 久未更新 |
| web-demuxer | 4.0.0（2025-12） | — | ✓ | ✓ | ffmpeg WASM，體積大 |

都沒有被標成 deprecated。

## §6 Cloudflare Realtime DataChannel（文件 2026-11-13 版，讀取 2026-11-27）

**使用者決定（2026-11-27）不再投資轉發**（流量成本），本節只保留查證摘要：文件支援「一個發布頻道、多位訂閱者」，預設可靠有序；所有訂閱者收同一串資料（不能各自從不同位置開始）、一個發布頻道只允許一位訂閱者回傳、沒寫吞吐上限；計費頁只寫「$0.05 per GB of egress」。來源：[DataChannels](https://developers.cloudflare.com/realtime/sfu/datachannels/)、[Pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)。

## §7 Windows 實驗頁（使用者要做的事）

1. 取得 `docs/decisions/assets/0007/encoder-lab.html`（可直接從 GitHub 分支下載這一個檔案）。
2. 在 Windows 上用 **Chrome 或 Edge 直接開檔**（雙擊，網址會是 `file:///…`）。本機已確認 `file://` 下 WebCodecs 與 WebRTC 都能用；需要網路，因為會從 jsDelivr 載入 mediabunny 1.65.2。
3. 選一支本機片（建議先用「1080P 衝不上 8 Mbps」那支，再用一支 4K），解析度 1080、位元率 8 Mbps，按「開始」。約 4～6 分鐘，不要切走分頁。跳出麥克風或鏡頭權限時按「允許」（不允許也能跑，只是讀不到 `encoderImplementation`）。
4. 完成後按「複製 JSON」貼回來。內容包含：GPU 名稱、每組測試的 `encoderImplementation`、實際位元率、平均 QP、編碼 fps、轉碼倍速、有沒有 B 幀，以及 WebRTC 每秒位元率。
5. 先不要關頁，開新分頁到 `chrome://webrtc-internals`（Edge 是 `edge://webrtc-internals`），按「Create dump」存檔。
6. 另外在**正式網站**用 P2P 開播同一支片 60 秒（有一位收看者），再到 `chrome://webrtc-internals` 按「Create dump」另存一份。兩份 dump 一起傳回。**分享前先遮蔽**：正式房間的 dump 含 IP、SDP 與 candidate（`a=candidate`、`c=IN IP4`／`IP6`、`address` 欄位），先刪除或改成 `x.x.x.x` 再傳；實驗頁的 dump 同樣處理。

測試組合：WebCodecs quality／realtime（硬體）、quality（軟體）；WebRTC 預設 `42001f`（硬體）、Safari 模式 `42e01f`（軟體）、方案 A（硬體＋上限 1.5 倍＋SDP 提示）。
