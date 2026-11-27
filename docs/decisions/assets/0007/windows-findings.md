# T-140 Windows 實測

## 測試條件

2026-11-27 使用 Playwright 啟動有視窗的 Google Chrome 158.0.8127.88。GPU 為 GeForce RTX 3080，驅動 610.88。Chrome DevTools Protocol 紀錄 WebCodecs 的編碼器名稱與硬體加速屬性。Windows 另以 `nvidia-smi encodersessions` 比對 Chrome 程序，確認 D3D12 硬編碼使用 NVIDIA 的 H.264 編碼工作階段。驅動清單以整個程序為單位，切換時可能同時看到前一組的工作階段。每組的實際編碼器依 Chrome 的編碼器名稱判定。

| 片源 | 原生解析度與幀率 | 檔案平均位元率 | 設定 |
| --- | --- | ---: | --- |
| `op78.mp4` | 1920×1080，29.97 fps | 19.9 Mbps | 1080P／8M、15M |
| `鏡之孤城.mkv` | 3840×2160，23.98 fps | 12.7 Mbps | 1080P／8M、15M，2160P／25M |
| `Yani Neko Ed-Animejanai.mp4` | 7680×4320，23.98 fps | 19.3 Mbps | 1080P／8M、15M |
| `2026-09-11 21-10-10.mp4` | 1920×1080，約 60 fps | 6.2 Mbps | 1080P／8M、15M |
| `《FX戰士久留美》OP.mkv` | 3840×2160，23.98 fps | 37.7 Mbps | 補測 2160P／25M |

WebCodecs 盡快轉碼 30 秒，同一片源及設定的各組共用片段。19 秒錄影使用全片。WebRTC 從同一進度播放，短片循環播放。各組單獨連線 40 秒、最高 30 fps，穩態統計自第 13 秒後採樣。WebRTC 只送視訊，虛擬麥克風用來開啟 Chrome 的編碼器統計。boost 將 `maxBitrate` 放大 1.5 倍，便於量測這項參數的單獨效果。

WebCodecs 的位元率以輸出壓縮位元組和呈現時間計算，QP 是每張最後一個 H.264 slice 的基本 luma QP。WebRTC 的位元率以 `outbound-rtp.bytesSent` 計算，QP 使用穩態區間的 `ΔqpSum ÷ ΔframesEncoded`。固定 QP 組由每格的 `avc.quantizer` 指定，沒有位元率目標。QP 沒有涵蓋 macroblock 的調整，也不能直接當作感知畫質分數。參見 [AVC WebCodecs 註冊](https://www.w3.org/TR/webcodecs-avc-codec-registration/#videoencoderencodeoptionsforavc) 和 [WebRTC 統計規格](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-qpsum)。

## WebCodecs 明細

格式為 Mbps／平均 QP。下表取 quality。60 對有輸出的 quality／realtime 組，在 JSON 精度下位元率及平均 QP 相同。相同路徑的 VBR／CBR 最大差距為 59 kbps。全部 100,896 張輸出影格都有可解析的 QP，已送交編碼的影格沒有遺失，輸出時間戳沒有觀察到重排。

| 片源與設定 | NVENC VBR | NVENC CBR | NVENC QP 22 | NVENC QP 26 | 軟體 VBR | 軟體 CBR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| op78・1080P／8M | 6.12／25.4 | 6.11／25.4 | 8.70／22.0 | 5.22／26.0 | 7.87／24.0 | 7.87／24.0 |
| op78・1080P／15M | 6.79／24.3 | 6.79／24.3 | 8.70／22.0 | 5.22／26.0 | 14.39／18.5 | 14.39／18.5 |
| 鏡之孤城・1080P／8M | 0.73／16.8 | 0.73／16.8 | 0.40／22.0 | 0.25／26.0 | 1.11／12.5 | 1.11／12.5 |
| 鏡之孤城・1080P／15M | 0.73／16.8 | 0.73／16.8 | 0.40／22.0 | 0.25／26.0 | 1.11／12.5 | 1.11／12.5 |
| 鏡之孤城・2160P／25M | 1.82／17.8 | 1.82／17.8 | 1.07／22.0 | 0.66／26.0 | 3.13／12.5 | 3.13／12.5 |
| 8K ED・1080P／8M | 3.88／35.4 | 3.93／35.2 | 13.76／22.0 | 8.65／26.0 | 7.57／28.0 | 7.57／28.0 |
| 8K ED・1080P／15M | 4.14／34.4 | 4.13／34.4 | 13.76／22.0 | 8.65／26.0 | 13.68／21.5 | 13.68／21.5 |
| 錄影・1080P／8M | 7.02／33.4 | 7.02／33.4 | 30.31／22.0 | 17.41／26.0 | 7.80／31.9 | 7.80／31.9 |
| 錄影・1080P／15M | 11.05／30.7 | 11.06／30.6 | 30.31／22.0 | 17.40／26.0 | 14.34／26.9 | 14.34／26.9 |
| FX 戰士 OP・2160P／25M | 5.19／35.2 | 5.19／35.2 | 14.55／22.0 | 9.88／26.0 | 22.01／19.1 | 22.01／19.1 |

4K 高碼率補測使用《FX戰士久留美》OP。25M 組的 NVENC VBR／CBR 都約 5.19 Mbps、QP 35.2。OpenH264 的 WebCodecs 實送 22.01 Mbps、QP 19.1。

## WebRTC 明細

格式為 Mbps／平均 QP／末次採樣解析度／穩態 fps。收到的 30 組連線都使用指定的 H.264 profile。42001f 的實際編碼器為 D3D12VideoEncodeAccelerator，42e01f 為 OpenH264。

| 片源與設定 | 42001f | boost | 42e01f（軟體） |
| --- | --- | --- | --- |
| op78・1080P／8M | 5.15／25.9／1280×720／30.0 | 5.88／25.4／1920×1080／30.0 | 7.83／25.2／1920×1080／29.9 |
| op78・1080P／15M | 5.84／25.5／1920×1080／30.0 | 5.87／25.4／1920×1080／30.0 | 13.57／19.6／1920×1080／29.9 |
| 鏡之孤城・1080P／8M | 0.90／16.7／1920×1080／24.0 | 1.06／16.5／1920×1080／24.0 | 1.62／12.1／1920×1080／24.0 |
| 鏡之孤城・1080P／15M | 1.06／16.5／1920×1080／24.0 | 1.06／16.5／1920×1080／24.0 | 1.61／12.1／1920×1080／24.0 |
| 鏡之孤城・2160P／25M | 2.43／19.4／3840×2160／24.0 | 2.45／19.4／3840×2160／24.0 | 3.58／12.8／3840×2160／23.9 |
| 8K ED・1080P／8M | 2.89／30.4／960×540／24.0 | 2.77／31.0／960×540／24.0 | 6.60／25.1／1920×1080／22.8 |
| 8K ED・1080P／15M | 2.88／30.4／960×540／23.9 | 2.87／30.4／960×540／24.0 | 10.53／19.9／1920×1080／22.3 |
| 錄影・1080P／8M | 6.07／25.5／1280×720／30.0 | 6.59／24.6／1280×720／30.0 | 7.30／24.7／1920×1080／29.9 |
| 錄影・1080P／15M | 6.46／24.7／1280×720／30.0 | 6.52／24.7／1280×720／30.0 | 13.35／22.0／1920×1080／29.9 |
| FX 戰士 OP・2160P／25M | 4.52／41.1／3840×2160／24.0 | 4.53／41.3／3840×2160／24.0 | 9.75／27.9／3840×2160／18.2 |

原始結果在 [results](results/) 的 `windows-*.json`。每個場景依 WebCodecs 的 latency mode 與 WebRTC 拆成三份。另附 [WebRTC Internals 的 30 份 dump 統計摘要](results/windows-webrtc-internals-summary.json)，原始壓縮 dump 保存在 Windows 本機暫存目錄。

## 驗證

- **PASS**　9 個指定場景加 1 個 4K 補測。120 個 WebCodecs 組與 30 個 WebRTC 組有量測值，40 個軟體固定 QP 組逐項紀錄 `supported: false`。30 份 dump 的編碼器資料與頁面 JSON 相符。
- **PASS**　注入 `NotAllowedError` 模擬麥克風與鏡頭均被拒，三個 WebRTC 組都標記「因權限被拒而未跑」。 [拒絕權限證據](results/windows-permission-denied.json)
- **PASS**　原型腳本的 `node --check`、局部 ESLint／Prettier 與結果 JSON 檢查。
- **FAIL（環境）**　`pnpm typecheck`、`pnpm lint`、`pnpm test` 已嘗試。pnpm 儲存區鎖存取遭拒，worktree 缺少依賴，且本機 Node 26.8.1 與專案要求的 Node 22 不符。
- **未測**　正式網站／遠端線路、Chrome 157、方案 A 的 SDP 起始提示、感知畫質評分，以及實際安裝的麥克風或鏡頭授權流程。

## 判讀與 ADR 建議

- **8M／15M 與 QP。** 四支指定片源轉 1080P 時，NVENC VBR／CBR 都低於設定值。錄影的 NVENC VBR 在 8M 和 15M 組分別為 7.02 Mbps／33.4 與 11.05 Mbps／30.7，OpenH264 則是 7.80 Mbps／31.9 與 14.34 Mbps／26.9。NVENC 固定 QP 能精確到 22／26，但同片約要 30.31／17.40 Mbps。OpenH264 的量化器模式由 `isConfigSupported` 明確判為不支援。
- **3.9 Mbps／QP 35。** 8K ED 重跑得到 VBR 3.88 Mbps／35.4，CBR 3.93 Mbps／35.2。把目標提高到 15M，仍是 4.14／4.13 Mbps、QP 34.4。同一段用固定 QP 26 可輸出 8.65 Mbps，固定 QP 22 可輸出 13.76 Mbps，兩者都沒有少送影格。高 QP 會減少輸出位元數，數據顯示自動速率控制在這段留下了位元率餘額。同一個硬體路徑也能以較低 QP 輸出更多位元。Chrome D3D12 程式允許 VBR 回退到 CBR，本次 API 與輸出證據無法分辨該回退是否發生或驅動內部採用的 QP 策略。見 [Chromium D3D12 rate control](https://chromium.googlesource.com/chromium/src/+/HEAD/media/gpu/windows/d3d12_video_encode_delegate.cc)。
- **D6。** 保留 `quality + variable` 作為跨平台預設，試轉時一起記錄實際速率、QP 與倍速。Windows 硬體在高 QP 且低於預算時，可試同一段的 OpenH264，確認畫質有改善、能超過 D6 的 1.2 倍速門檻並符合房間預算後再採用。低位元率與低 QP 並存的片段，例如《鏡之孤城》片頭，可繼續用原設定。CBR 的結果與 VBR 接近。固定 QP 適合診斷，採為產品模式前需驗證短時峰值、頻寬預算與回退。
- **D12。** 四個 1080P／8M 場景中，NVENC boost 的穩態均低於 8 Mbps。最高是錄影的 6.59 Mbps／QP 24.6，基準為 6.07 Mbps／QP 25.5，兩者最後解析度均為 1280×720。`op78.mp4` 從 1280×720 升到 1920×1080，boost 仍只有 5.88 Mbps。建議延後方案 A。這批測的是 `maxBitrate` 單獨放大，含 `x-google-start-bitrate` 的組合仍待量測。

## HEVC 入口掃描

候選範圍是 `C:` 使用者的 Videos／Downloads／Desktop，以及 `D:`、`E:` 可讀的媒體檔，排除了遊戲安裝、應用程式快取與系統目錄。238 個 MP4／MKV 候選中，210 個的首個視訊軌是其他編碼，27 個是 HEVC，另有一個空檔。以檔案為統計單位，未依內容去重。

FFmpeg 只讀拆封首個視訊軌。掃描腳本依解碼順序讀 NAL，每張 IRAP／RASL／RADL 只計第一個 slice。實測 27 部 HEVC 共 4,869 個 IDR、0 個 CRA，帶前導畫面的有 **0／27**。27 部都有無前導畫面的入口，其中 3 部各只有 1 個 IDR。表內「通過」表示符合 ADR 第一版的 GOP 入口條件，原片直送仍須另驗收音訊、時間軸與收看端解碼能力。

建議第一版維持 D5 的入口限制。這批片庫沒有因前導畫面而被排除的片源。另用 x265 建立的 open-GOP 測試片驗證了正例。掃描器與 FFmpeg `trace_headers` 都數到 1 個 IDR、3 個 CRA、9 個 RASL，只有初始 IDR 可作第一版入口。此片用於驗證掃描器，未計入片庫比例。規格對前導畫面的定義見 [RFC 7798 §3.1.1](https://www.rfc-editor.org/rfc/rfc7798.html#section-3.1.1)。

| 檔名 | 容器 | IDR | CRA | RASL／RADL | ADR 第一版 GOP |
| --- | --- | ---: | ---: | --- | --- |
| 尼古喵喵 ED .mkv | MKV | 9 | 0 | 0／0 | 通過 |
| 尼古喵喵 ED -animejanai.mkv | MKV | 1 | 0 | 0／0 | 通過 |
| 《尼古喵喵》第3話 (繁中字幕 _ 日語原聲)【Ani-One】-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《尼古喵喵》第2話 (繁中字幕 _ 日語原聲)【Ani-One】-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《尼古喵喵》第1話 (繁中字幕 _ 日語原聲)【Ani-One】.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| TVアニメ『ヤニねこ』ノンクレジットオープニング映像｜忘れらんねえよ「なんもねえ」-animejanai.mkv | MKV | 9 | 0 | 0／0 | 通過 |
| TVアニメ『ヤニねこ』ノンクレジットエンディング映像｜ネクライトーキー「煙とブルー」-animejanai.mkv | MKV | 9 | 0 | 0／0 | 通過 |
| perfectMoment_9213839720407094540_20-animejanai.mkv | MKV | 1 | 0 | 0／0 | 通過 |
| 鏡之孤城.mkv | MKV | 669 | 0 | 0／0 | 通過 |
| [YYQSUB] Zombie Land Saga - Yumeginga Paradise [BDRip][4k][AVC_AAC][JPSC].mkv | MKV | 696 | 0 | 0／0 | 通過 |
| [Nameless Fansub] Girls Band Cry The Movie Part 2 Naa, Mirai. [WebRip][AVC-8bit 1080p AAC][JPSC][v2]-animejanai.mkv | MKV | 636 | 0 | 0／0 | 通過 |
| [Nameless Fansub] Girls Band Cry The Movie Part 1 Seishun Kyousoukyoku [WebRip][AVC-8bit 1080p AAC][JPSC][v2]-animejanai.mkv | MKV | 635 | 0 | 0／0 | 通過 |
| [DMG&VCB-Studio] 劇場版 天気の子 [BDRip][AVC_AAC][1080P][CHS](D87FC302)-animejanai.mkv | MKV | 646 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第8話 (繁中字幕 ｜ 日語原聲)【Ani-One】-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第7話 (繁中字幕 ｜ 日語原聲)【Ani-One】 [4GQ0AZEP0H0]-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第6話 (繁中字幕 ｜ 日語原聲)【Ani-One】 [L-ZHYxoUzX4]-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第5話 (繁中字幕 ｜ 日語原聲)【Ani-One】 [YsgH8Yb7kaE]-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第4話 (繁中字幕 ｜ 日語原聲)【Ani-One】 [QUTfP-4bgh8]-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第3話 (繁中字幕 ｜ 日語原聲)【Ani-One】 [e4D_431sxJk]-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第2話 (繁中字幕 ｜ 日語原聲)【Ani-One】 [F_vcb34Uqcg]-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》第1話 (繁中字幕 ｜ 日語原聲)【Ani-One】 [wF6r7ZvfxlQ]-animejanai.mkv | MKV | 137 | 0 | 0／0 | 通過 |
| 《FX戰士久留美》OP.mkv | MKV | 9 | 0 | 0／0 | 通過 |
| 『無限大ANANTA』リリース日発表PV丨27年1月15日グローバルリリース [QMyhhKJq_l4]-animejanai.mkv | MKV | 1 | 0 | 0／0 | 通過 |
| 4k120.mkv | MKV | 18 | 0 | 0／0 | 通過 |
| 332.mkv | MKV | 9 | 0 | 0／0 | 通過 |
| 33-animejanai.mkv | MKV | 9 | 0 | 0／0 | 通過 |
| 290239576-1-208.mp4 | MP4 | 5 | 0 | 0／0 | 通過 |

原始計數見 [windows-hevc-gop.json](results/windows-hevc-gop.json)。
