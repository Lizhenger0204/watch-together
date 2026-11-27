# ADR 0007 原型（T-140）

**實驗用，不是正式程式碼**，不進 `apps/`、不做單元測試。每個 `.js`／`.mjs` 開頭都有 `eslint-disable`（根目錄 ESLint 設定歸 GPT，不改）。結果與結論見 [附錄 A](../../0007-appendix-a-evidence.md)，原始 JSON 在 `results/`。

**種子式散布原型的簡化**（附錄 E §3）：整段收完才驗證與轉送（沒做小塊邊收邊轉）、急件直送給每個人（4K 大片段時房主頻寬不夠）、一次檢舉就停用來源、同機省略對時。

**已知錯誤，正式版不可照抄**：`fmp4.js` 以「片段內 PTS 排序」推 DTS，只適用固定幀率、封閉 GOP 的片源；可變幀率＋open GOP 會讓片段間出現缺口，負時間戳會被截成 0（附錄 B §3）。追趕與背壓的正式規則以附錄 C 為準，原型只實作了其中一部分。

需要 Google Chrome（Playwright `channel: 'chrome'`）。指令都在 repo 根目錄執行。拆檔套件 mediabunny 預設從 jsDelivr 載入固定版本 1.65.2；離線時以 `npm pack mediabunny@1.65.2` 取得 `dist/bundles/mediabunny.min.mjs`，放進某個資料夾，再設 `LAB_VENDOR=<資料夾>`。

| 檔案 | 用途 |
| --- | --- |
| `encoder-lab.html` | **Windows 實驗頁**（單檔，雙擊開啟）：WebCodecs 轉碼與 WebRTC 編碼對照，輸出 JSON。步驟見附錄 A §7 |
| `run-encoder-lab.mjs` | 本機用 Playwright 跑上面那一頁：`node docs/decisions/assets/0007/run-encoder-lab.mjs <影片> 1080 8 30 40`（高度、Mbps、WebCodecs 秒數、WebRTC 秒數） |
| `passthrough.html`、`host.js`、`viewer.js` | 原片直送：房主拆檔、配速送出、收看端 MSE 與對時追趕 |
| `fmp4.js` | 最小 fMP4 封裝器（見上方已知錯誤） |
| `proto.js` | 分頁間信令（BroadcastChannel）、分塊格式、對時、追趕規則 |
| `run-passthrough.mjs` | 房主＋兩位收看者：`node docs/decisions/assets/0007/run-passthrough.mjs <影片> "budget=100"`（`SCENARIO=steady` 只量穩態；`TIMELINE=1` 附時間線；`HEADLESS=1` 不開視窗） |
| `formats.js`、`run-formats.mjs` | 片源能否走原片直送：`node docs/decisions/assets/0007/run-formats.mjs e2e/fixtures h264-aac.mp4 hevc-aac.mkv` |
| `dc-bench.html`、`dc-bench.js`、`run-dc-bench.mjs` | DataChannel 吞吐與配速：`node docs/decisions/assets/0007/run-dc-bench.mjs "rate=50" 2 20`（query、人數、秒數；`HEADLESS=0` 開視窗） |
| `lab-server.mjs` | 支援 Range 的本機靜態伺服器（`/lab/`、`/media/`、`/vendor/`） |
| `swarm.html`、`swarm-host.js`、`swarm-viewer.js`、`swarm-common.js` | 種子式散布（附錄 D、E）：房主協調指派、收看者互相轉送、SHA-256 驗證；收看端用 hls.js 1.7.4 light 的自訂 loader 從記憶體倉庫取片段 |
| `run-swarm.mjs` | 房主＋N 位收看者：`node docs/decisions/assets/0007/run-swarm.mjs <影片> 3 [房主 query] [收看者 query]`；`EVIL=B`（B 竄改轉送資料）、`NOUP=C`（C 不上傳）、`LEAVE=1`（最後一位離開、新的一位加入）、`DUMP=1`（附收看端狀態）。房主 query：`budget`（Mbps）、`copies`（直送份數）、`swarm=0`（對照組）；收看者 query：`up`（上傳 Mbps）、`debug=1` |

原片直送可調的 query：`lead`（超前秒數）、`budget`（總上傳預算 Mbps）、`pace`／`paceCatchup`（配速倍數）、`chunk`、`high`／`low`（`bufferedAmount` 水位）、`smartStart=0`（只從前一個關鍵影格開始）、`seekWait=1`（跳轉後等收看者）、`dead`（追趕死區秒數）、`debug=1`（收看端附加紀錄）。

附錄 A 的長片用 ffmpeg 產生（放在 repo 外）：

```sh
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=24,noise=alls=10:allf=t" -f lavfi -i "sine=f=440:sample_rate=48000:beep_factor=4" -t 120 -c:v libx264 -preset veryfast -profile:v high -b:v 8M -maxrate 12M -bufsize 16M -bf 3 -g 240 -keyint_min 24 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart h264-1080p-120s.mp4
ffmpeg -f lavfi -i "testsrc2=size=3840x2160:rate=24,noise=alls=10:allf=t" -f lavfi -i "sine=f=660:sample_rate=48000:beep_factor=4" -t 90 -c:v hevc_videotoolbox -b:v 40M -g 120 -pix_fmt yuv420p -c:a aac -b:a 192k hevc-2160p-90s.mkv
ffmpeg -f lavfi -i "testsrc2=size=3840x2160:rate=24,noise=alls=10:allf=t" -f lavfi -i "sine=f=880:sample_rate=48000:beep_factor=4" -t 60 -c:v hevc_videotoolbox -profile:v main10 -pix_fmt p010le -b:v 30M -g 120 -tag:v hvc1 -c:a aac -b:a 192k -movflags +faststart hevc-main10-2160p-60s.mp4
ffmpeg -stream_loop 14 -i <bug004-evidence>/media/4k-main8.mp4 -c copy -tag:v hvc1 -movflags +faststart hevc-real4k-loop-60s.mp4
ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=24" -f lavfi -i "sine=f=440:sample_rate=48000" -t 20 -c:v libx264 -preset veryfast -b:v 3M -c:a ac3 -b:a 384k h264-ac3-20s.mkv
```

`hevc_videotoolbox` 只有 macOS 有；其他平台可改 `libx265`。
