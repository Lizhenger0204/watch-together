# ADR 0006：HEVC「標頭標成 Main 10、實際是 8-bit」畸形片源的偵測、診斷與自動修正

- 狀態：**已拍板**（任務 T-138；使用者 2026-11-27 同意做法 1＋做法 2A 單分支一次實作並送 `gpt-6.2-sol` 審查，待 T-136 合併進 `main` 後開 `gemini/T-138-hevc-profile` worktree 開工）
- 日期：2026-11-27
- 相關：BUG-003（已結案）、BUG-004（T-136）、`docs/specs/streaming.md` §1、T-135（已結案，不實作）
- 範圍：只動房主端 `features/source/`、`e2e/` 與說明文件；收看端、傳輸層介面、伺服器不變

## 背景與已確認事實

1. **現象與根因（BUG-003）**：使用者的 4K MKV 片源（`animejanai` + `hevc_nvenc` 產生），HEVC 標頭（容器的 `hvcC`／`CodecPrivate`，以及 VPS／SPS 的 `profile_tier_level`）宣告 **Main 10**（`general_profile_idc = 2`），但 SPS 實際位元深度為 **8-bit**（`bit_depth_luma_minus8 = 0`、`bit_depth_chroma_minus8 = 0`，`yuv420p`）。
   - ITU-T H.265 規範在語法上允許 Main 10 profile 承載 8-bit 樣本，但實務上多為編碼工具誤設 profile。
   - **Windows（Chrome，RTX 3080 12G）**：原生試播失敗，報 `PIPELINE_ERROR_DECODE: GetVideoDecoderConfigCount failed: 參數錯誤。 (0x80070057)`，D3D11 硬體解碼管線拒絕此矛盾組態。
   - **macOS（Chrome 158，VideoToolbox）**：同一支片可直接解碼與播放（解碼器較寬鬆）。
   - **無損修正已獲實機證實**：使用者以自製工具 `HevcFixerGui` 將 `hvcC`／VPS／SPS 三處 profile 標記改回 Main（不重新編碼）後，**Windows Chrome 已可正常播放**。
2. **與 MKV 容器無關**：T-135（MKV 支援）與 BUG-003 皆已結案。
3. **與 BUG-004（T-136）的區別**：
   - **BUG-004** 是**真正的 10-bit 畫面**（`profile_idc = 2` 且 `bit_depth = 10`）經 `captureStream()` 送進 WebRTC 時使 Chrome 分頁崩潰，解法是依首幀 `VideoFrame.format` 判斷，於送出前經 `OffscreenCanvas` 轉成 8-bit。
   - **T-138（本 ADR）** 是**假 Main 10、實 8-bit**（`profile_idc = 2` 且 `bit_depth = 8`）造成 Windows D3D11 解碼前即拒絕；兩者偵測邏輯不可互相誤判。

## 本機實測與查證（2026-11-27）

### 1. macOS Chrome 158 對四類片源的實測

以 Playwright `channel: 'chrome'` 測試 `e2e/fixtures/` 的四類 × 兩種容器素材（MP4／MKV），並讀取 `captureStream()` 首幀 `VideoFrame.format`：

| 片源類型 | 容器 | `<video>` 解碼 | 首幀 `VideoFrame.format` | BUG-004 判斷 |
| --- | --- | --- | --- | --- |
| 正常 Main 8（`profile=1, 8-bit`） | MP4 / MKV | 成功 | `NV12` | 直接送出（`converted: false`） |
| 正常 Main 10（`profile=2, 10-bit`） | MP4 / MKV | 成功 | `null`（opaque） | 轉 8-bit（`converted: true`） |
| 畸形片（`profile=2, 8-bit`） | MP4 / MKV | 成功 | **`NV12`** | 直接送出（`converted: false`） |
| 修正版（免重編碼改回 `profile=1, 8-bit`） | MP4 / MKV | 成功 | `NV12` | 直接送出（`converted: false`） |

**結論**：畸形片在 macOS 解出的 `VideoFrame.format` 是 **`NV12`**（8-bit），BUG-004 的首幀格式判斷不會誤把它當真 10-bit。只要偵測邏輯同時核對 `general_profile_idc === 2` **且** `bitDepthLuma === 8 && bitDepthChroma === 8`，三種片源就能完全分離，絕不互相誤判。

### 2. FFmpeg `hevc_metadata` 查證

本機 FFmpeg 9.1（`ffmpeg -h bsf=hevc_metadata`）與官方文件確認：

- `hevc_metadata` 只支援 `aud`、`sample_aspect_ratio`、`video_format`、`video_full_range_flag`、`colour_primaries`、`transfer_characteristics`、`matrix_coefficients`、`chroma_sample_loc_type`、`tick_rate`、`num_ticks_poc_diff_one`、`crop_*`、`width`、`height`、`level`。
- **沒有 `profile` 選項**，且 FFmpeg 內建的 HEVC bitstream filter 僅有 `hevc_metadata` 與 `hevc_mp4toannexb`，**無法用現成 FFmpeg 指令免重新編碼修改 profile**。
- 因此轉檔備案指令仍需視訊重新編碼、音訊直接複製（`-c:a copy`）：優先 NVIDIA `hevc_nvenc`，次選 CPU `libx265`。

### 3. 免重編碼修補最小原型驗證

以純 Node 原型直接解析畸形片的 `hvcC`／`CodecPrivate` 與所有關鍵幀前的 VPS（NAL type 32）／SPS（NAL type 33），執行 **EBSP → RBSP（移除 `0x00 0x00 0x03`）→ 改寫 `general_profile_idc`（`2 → 1`）與 `general_profile_compatibility_flags`（`0x20000000 → 0x60000000`）→ RBSP → EBSP**，產出 `e2e/fixtures/hevc-main10-8bit-fixed-aac.{mp4,mkv}`：

- `ffprobe` 顯示 `profile=Main`、`pix_fmt=yuv420p`；
- `ffmpeg -bsf:v trace_headers` 確認 Extradata 與每個關鍵幀前的 VPS／SPS 全數更新；
- 畸形片與修正版解碼後的原始像素 MD5 **完全一致**（MP4：`7603adce85ead7d180e5fc7a3ff680c7`；MKV：`a938f2d00d5737ac5a085773e9dee771`），證明 100% 無損、免重新編碼。

### 4. Windows 真實電影庫掃描與 `HevcFixerGui` 歷史實證（2026-11-27）

從 `D:\video\HevcFixerGui`（`.hevc-fix-history.jsonl`）與 Windows 實片掃描確認：

- **14 部已修補的真實 MKV**：每部僅修改 **3 處**（共 42 處，皆 `22 20 → 21 60`），**全部位於 `CodecPrivate` 內，從未修改 `mdat`／Cluster**。
- **15 部真實 HEVC 片源全檔掃描**（含 5 部 11.1–34.2 GB 的 4K MKV、9 部 425 MB–4.12 GB 的 MKV、1 部 `hvc1` MP4，合計 1,096,958 個視訊封包、4,392 個 IDR 關鍵幀）：**in-band VPS／SPS／PPS 全為 0**。
- **全檔掃描代價**：SATA SSD（515–538 MB/s）掃描 34.2 GB 電影需 **75.6 秒**（傳統 HDD 預估 3–5 分鐘）。因此瀏覽器端**絕不做全檔掃描**，改採「標頭零複製修補（3 段 Blob）＋首個／中段關鍵幀抽查」；若抽查發現 in-band VPS／SPS 且無法等長安全修補，直接降級回做法 1 診斷與轉檔指引。

---

## 候選做法比較

### 做法 1：檔頭偵測＋精準診斷＋引導轉檔（必做基礎）

1. **輕量純 TS 解析器（零新依賴）**：
   - 選檔後以 `File.slice()` 只讀檔頭（及 MP4 `moov` 在檔尾時讀檔尾小區塊），不載入整支電影。
   - 支援 **MP4 / M4V / MOV**（`moov/trak/mdia/minf/stbl/stsd` → `hvc1`/`hev1` → `hvcC`）與 **MKV**（EBML `Tracks` → `CodecID = V_MPEGH/ISO/HEVC` → `CodecPrivate`，結構與 `hvcC` 同為 `HEVCDecoderConfigurationRecord`）。
   - 讀出 `general_profile_idc` 與 `bitDepthLumaMinus8`／`bitDepthChromaMinus8`，並對 `hvcC`／`CodecPrivate` 內**全部** SPS（NAL type 33）去除防偽零位元組（EBSP→RBSP）後嚴格核對安全邊界：`general_profile_space === 0`、`general_profile_idc === 2`、`chroma_format_idc === 1`（4:2:0）、`bit_depth_luma_minus8 === 0`、`bit_depth_chroma_minus8 === 0`、無 sub-layer Main 10 profile、無 MKV `ContentEncodings` 壓縮／加密；並支援檔尾 `moov`（含 64-bit box size）與 `SeekHead` 指向檔尾的 MKV `Tracks`（讀取量 < 2 MB、毫秒級完成；缺 SPS 時再讀第一個關鍵幀）。
   - 三態判定：
     - `profileIdc === 1 && bitDepth === 8` → 正常 Main 8；
     - `profileIdc === 2 && bitDepth === 10` → 正常 Main 10（由 BUG-004 依首幀 `VideoFrame.format` 轉 8-bit）；
     - `profileIdc === 2 && bitDepthLuma === 8 && bitDepthChroma === 8` → **`mismatchMain10On8Bit = true`**（畸形片）。
2. **關鍵決策：試播前不直接擋下，失敗時才報專屬診斷（或觸發自動修正）**
   - 理由：同一支畸形片在 macOS 與寬鬆驅動上本來就能播（且首幀為 `NV12`，不觸發 BUG-004 崩潰）；符合 `streaming.md` §1「須以實際試播確認」原則。
   - 若試播失敗且 `mismatchMain10On8Bit === true`，回傳專屬錯誤碼 **`HEVC_PROFILE_MISMATCH`**，明確告知「這支影片的 HEVC 標頭有誤（標成 Main 10／10-bit，實際畫面是 8-bit），Windows 硬體解碼器不接受這種矛盾設定」，附上一鍵複製的 FFmpeg 轉檔指令（並寫入使用說明）：
     - NVIDIA GPU（推薦，最快）：
       ```sh
       ffmpeg -i "input.mkv" -c:v hevc_nvenc -profile:v main -pix_fmt yuv420p -cq 20 -tag:v hvc1 -c:a copy -movflags +faststart "output.mp4"
       ```
     - 無 NVIDIA（CPU）：
       ```sh
       ffmpeg -i "input.mkv" -c:v libx265 -pix_fmt yuv420p -crf 20 -tag:v hvc1 -c:a copy -movflags +faststart "output.mp4"
       ```
     - 若原片音訊非 MP4 相容格式（如 AC-3），把 `-c:a copy` 改為 `-c:a aac -b:a 192k`。

### 做法 2A：瀏覽器內「零複製 Blob 拼接」自動修正（推薦，無需 MSE、零新依賴）

- **核心原理**：不重新編碼、不複製 50 GB 檔案、不引入 `mediabunny` 或 MSE。當偵測到 `mismatchMain10On8Bit === true` **且**原檔試播失敗時，只把檔頭中極小一段 `hvcC`（MP4）或 `CodecPrivate`（MKV）取出修補，再用 **`new Blob([file.slice(0, start), patchedChunk, file.slice(end)])`** 零複製拼出新的虛擬 `Blob`，以 `URL.createObjectURL(patchedBlob)` 交給原本的 `<video>` 重試試播！
- **為什麼「零複製 Blob 拼接」大幅勝過 MSE**：
  1. **零記憶體複製**：`Blob` 組合 `File.slice()` 只記錄偏移指標，50 GB 電影實際複製到記憶體的只有幾十 KB（修補區段），毫秒級完成。
  2. **沿用原生 `<video>`**：播放、暫停、任意拖進度、緩衝、播完重播、`captureStream()`、音量與控制列 100% 沿用既有程式碼，**零 MSE 複雜度**、零 `QuotaExceededError`、零新套件。
  3. **實機已證實**：使用者用 `HevcFixerGui` 只修改 `hvcC`／VPS／SPS 三處 profile 後 Windows Chrome 即可播，代表多數此類片源（`animejanai` + `hevc_nvenc`）只要修正這三處就生效。
- **必須嚴謹處理的技術細節與降級邊界**：
  1. **防偽零位元組（EBSP ↔ RBSP）與長度變化**：
     - 常見情況：`general_profile_idc` 從 `2` 改 `1`、`general_profile_compatibility_flags` 從 `0x20000000` 改 `0x60000000`，EBSP 結果長度**完全不變**，可直接原地等長替換（連外層 EBML／MP4 box size 與全部 offset 都不需動）。對每個改寫後的 VPS／SPS NALU 都必須執行 **EBSP↔RBSP 往返斷言**（防止例如 `oldB1 === 0x00` 後接 `00 03` 使既有 EPB 失效，並確認無非法 `00 00 00/01/02/03`），不通過則拒改並降級回做法 1。
     - 若某些片源在改寫後因 `0x00 0x00 0x03` 增減而**改變 NALU 長度**：
       - **MP4**：重建 `moov`（更新 `hvcC` → `hvc1`/`hev1` → `stsd` → … → `moov` 長度，若 `moov` 在 `mdat` 前面則同步平移 `stco`/`co64` chunk offset），再與原檔的 `mdat` 做零複製 Blob 拼接。
       - **MKV**：更新 `CodecPrivate` 與上層 EBML VINT size（若 `Tracks` 總長改變，且後方有 `SeekHead`/`Cues` 絕對偏移，則只有在可無痛重寫或原地補 `Void` padding 時才套用，否則安全降級回做法 1 診斷）。
  2. **每個關鍵幀前重複出現的 in-band VPS／SPS**：
     - 先檢查第一個關鍵幀（及若有 `stss`／`Cues` 可抽查第二個關鍵幀）是否含 in-band VPS／SPS：
       - **沒有 in-band VPS／SPS**（標準 `hvc1` MP4 與多數只寫在 `CodecPrivate` 的 MKV）：只修檔頭 `hvcC`／`CodecPrivate` 即完成，毫秒級零複製。
       - **有 in-band VPS／SPS**：
         - MP4 可依 `stss`＋`stsz`＋`stco`/`co64` 直接定位所有關鍵幀偏移，若改寫皆為等長替換，直接零複製拼接；若關鍵幀過多（例如 > 5,000 個）或發生長度變化需改寫整份 `mdat` 偏移，則安全降級回做法 1（報 `HEVC_PROFILE_MISMATCH`＋轉檔指引），避免在瀏覽器內對 50 GB 檔做全檔重封裝。
         - MKV 若有 `Cues` 且關鍵幀改寫皆為等長替換，同樣可只讀各 Cue 指向的關鍵幀開頭做零複製拼接；若無 `Cues` 或改寫變長，安全降級回做法 1（若只修 `CodecPrivate` 後重試試播仍失敗，亦降級回做法 1）。
  3. **診斷透明度**：自動修正成功後，於 `ready`／`warning` 資訊旁標註「已自動修正 HEVC 標頭（Main 10 → Main，8-bit）」，且仍不觸發 BUG-004 10-bit 轉換（`converted: false`）。若自動修正後重試依然失敗，保留兩次試播的診斷並回報 `HEVC_PROFILE_MISMATCH`＋轉檔指令。

### 做法 2B：瀏覽器內「轉封裝成 fMP4 + MSE」自動修正（備選，較重）

- 沿用 ADR 0003（`claude/T-135-mkv-hevc`）架構，引入 `mediabunny`（MPL-2.0），在轉封裝為 fMP4 送進 MSE 時即時改寫 `hvcC` 與每個關鍵幀前的 in-band VPS／SPS。
- **優點**：即使遇到「無 Cues 的 50 GB MKV」或「每個關鍵幀 in-band VPS／SPS 改寫後長度改變」，fMP4 重封裝也能逐段處理。
- **缺點**：需引入外部套件並實作整套 MSE 緩衝管理、拖進度、播完重播、`QuotaExceededError`、音訊同步，維護成本遠高於做法 2A；而且目前 T-135 已經結案不導入 MSE。
- **結論**：**先不做做法 2B**；唯有實務上大量遇到「做法 2A 無法等長修補、必須靠 MSE 逐段重封裝」的真實片源時，再另開任務評估。

### 做法 3：WebCodecs 用修正後的設定解碼（不採用）

- 單改 `VideoDecoder.configure({ codec: 'hvc1.1.6.L...' })` 無法繞過 Windows D3D11：WebCodecs 與 `<video>` 共用 `D3D11VideoDecoder`／`H265Decoder`，底層仍會讀 `description`（`hvcC`）與 bitstream 裡的 VPS／SPS 而報錯。
- 若連 `description` 與 in-band VPS／SPS 都改寫後交給 `VideoDecoder`，還得重寫整套播放器（時鐘、影音同步、B-frame 重排、拖進度、控制列、擷取），工程量是做法 2B 的 3～5 倍、更是做法 2A 的十倍以上。**明確不採用。**

### 方案總覽比較

| 比較項目 | 做法 1：偵測＋診斷＋轉檔指引 | 做法 2A：零複製 Blob 拼接（推薦） | 做法 2B：fMP4 + MSE | 做法 3：WebCodecs |
| --- | --- | --- | --- | --- |
| Windows 畸形片免轉檔開播 | 否 | **是**（免重編碼、毫秒完成） | 是 | 預期失敗／成本過高 |
| 新增套件依賴 | 無 | **無（零依賴）** | `mediabunny`（MPL-2.0） | `mediabunny` + 自寫播放器 |
| 記憶體與大檔（50 GB） | 僅讀檔頭數十 KB | **零複製 `File.slice()` 拼接** | 需管理 100 MB MSE 緩衝 | 需自管解碼佇列 |
| 既有播放／拖進度／擷取 | 完全沿用 | **完全沿用原生 `<video>`** | 需重做拖進度／重播／配額 | 需重寫播放器 |
| 風險與維護成本 | 極低 | **低（不可等長修補時自動降級回做法 1）** | 中高 | 極高 |
| 建議 | **Phase 1 必做** | **Phase 2 推薦（或合併進 Phase 1）** | 暫不做 | **不採用** |

---

## 推薦決定與分階段計畫

推薦採用 **「做法 1（偵測＋精準診斷＋轉檔指引）＋做法 2A（零複製 Blob 拼接自動修正）」**，分成兩個清晰階段（並先透過下方 Windows 驗證表確認素材表現）：

- **Gate 0（本回合已備妥素材，請使用者於 Windows 實測）**：
  - 以 `e2e/fixtures/` 內 8 支素材確認：(a) `malformed` MP4／MKV 在 Windows 重現 `0x80070057`；(b) `fixed` MP4／MKV（含純 Node 修補的 MP4 與含重複 in-band VPS／SPS 的 MKV）在 Windows 皆可正常播。
- **Phase 1（偵測＋診斷＋轉檔指引，零依賴）**：
  1. 契約先行：更新 `docs/specs/streaming.md` §1（補齊 HEVC 標頭偵測、`HEVC_PROFILE_MISMATCH` 錯誤碼、診斷欄位與轉檔提示規則）。
  2. 在 `features/source/` 新增純 TS 模組 `hevc-header.ts`（`File.slice()` 讀 MP4 `hvcC`／MKV `CodecPrivate`／首關鍵幀 SPS、EBSP→RBSP 解析、`mismatchMain10On8Bit` 判斷）。
  3. 整合至 `source-check.ts`、`use-local-source.ts`、`SourceDiagnostics.tsx`、`HostSourcePlayer.tsx`（含一鍵複製轉檔指令），並更新使用說明。
  4. 補齊單元測試與真 Chrome E2E（含改壞驗證）。
- **Phase 2（零複製 Blob 拼接自動修正，零依賴）**：
  1. 在 `hevc-profile-patch.ts`（遵守單檔 ≤ 20 KB）實作 EBSP↔RBSP 改寫與往返斷言、等長原地 Blob 拼接（MP4 `hvcC`＋MKV `CodecPrivate`＋有索引時的等長 in-band VPS／SPS）、MP4 `moov` 變長重寫與 `stco`/`co64` 更新；無法安全修補或重試失敗時降級回 Phase 1。
  2. 原生試播失敗且 `mismatchMain10On8Bit === true` 時，自動以修補 `Blob` 的新 Object URL 重試（釋放或換檔時撤銷所有 URL）。
  3. 補齊單元測試（EPB 新增／消失、往返斷言、`stco`/`co64` 更新、in-band 重複 VPS／SPS）與真 Chrome E2E（含改壞驗證）。

### 與 T-136（`gemini/BUG-004-10bit-capture`）的實作順序

`gemini/BUG-004-10bit-capture` 與 T-138 都會修改 `features/source/` 同一批檔案（`source-check.ts`、`browser-source.ts`、`use-local-source.ts`、`SourceDiagnostics.tsx`、`HostSourcePlayer.tsx`）與 `e2e/source.spec.ts`。**建議先讓 T-136 完成阻擋項修正並合併進 `main`，再由 T-138 從最新 `main` 開 worktree 實作**，避免重複解決衝突，也能直接在 E2E 同時驗證「真 10-bit（`converted: true`）」與「假 Main 10 實 8-bit（`converted: false`／自動修正或 `HEVC_PROFILE_MISMATCH`）」互不誤判。

---

## Windows 實機驗證表（請使用者依序測試）

所有素材均位於 `e2e/fixtures/`（單檔 ≤ 1 MB，MKV 皆 ≤ 20 KB），可啟動 `pnpm dev` 開啟 `/?demo=source` 依序選檔，或直接拖進 Windows Chrome 分頁測試：

| 順序 | 檔名（`e2e/fixtures/`） | 內容說明 | 驗證重點 | Windows Chrome（RTX 3080）預期結果 |
| --- | --- | --- | --- | --- |
| 1 | `hevc-aac.mp4` | 正常 Main 8（`profile=1`, `8-bit`, `hvc1`） | 基準線（MP4） | 檢查通過、正常播放與擷取（1 影 1 音） |
| 2 | `hevc-aac.mkv` | 正常 Main 8（`profile=1`, `8-bit`） | 基準線（MKV） | 檢查通過、正常播放與擷取 |
| 3 | `hevc-main10-aac.mp4` | 正常 Main 10（`profile=2`, `10-bit`, `hvc1`） | 真 10-bit 基準（MP4） | 檢查通過、可解碼 |
| 4 | `hevc-main10-aac.mkv` | 正常 Main 10（`profile=2`, `10-bit`） | 真 10-bit 基準（MKV） | 檢查通過、可解碼 |
| 5 | `hevc-main10-8bit-malformed-aac.mp4` | **畸形片**：標頭 Main 10、實際 8-bit（`hvc1`） | 重現 BUG-003（MP4） | **預期失敗**，靜音試播報 `PIPELINE_ERROR_DECODE` / `0x80070057` |
| 6 | `hevc-main10-8bit-malformed-aac.mkv` | **畸形片**：標頭 Main 10、實際 8-bit（`CodecPrivate` + 兩關鍵幀重複 in-band VPS/SPS） | 重現 BUG-003（MKV） | **預期失敗**，靜音試播報 `PIPELINE_ERROR_DECODE` / `0x80070057` |
| 7 | `hevc-main10-8bit-fixed-aac.mp4` | **修正版**：由 #5 免重編碼改回 Main（純 Node 原型） | 驗證 MP4 零複製修補 | **關鍵**：檢查通過、正常播放（確認純 Node 原型在 Windows 有效） |
| 8 | `hevc-main10-8bit-fixed-aac.mkv` | **修正版**：由 #6 免重編碼改回 Main（含重複 in-band VPS/SPS） | 驗證 MKV 含 in-band 修補 | **關鍵**：檢查通過、正常播放（確認連重複 in-band VPS/SPS 修補也有效） |

## 使用者決定（2026-11-27）

1. 採用 **做法 1（偵測＋診斷＋轉檔指引）＋做法 2A（零複製 Blob 拼接免重編碼修補）**，不做做法 2B（MSE）與做法 3（WebCodecs）。
2. 於單一分支（`gemini/T-138-hevc-profile`）一次完成 Phase 1＋Phase 2，通過測試與改壞驗證後送 GPT（`gpt-6.2-sol`，`high`）審查。
3. 試播前不擋下；原生試播失敗且偵測為畸形片時自動以做法 2A 修補重試，仍失敗才報 `HEVC_PROFILE_MISMATCH` 與轉檔指令。
4. 等 T-136（`gemini/BUG-004-10bit-capture`）合併進 `main` 後再開 worktree 實作，避免 `features/source/` 衝突。
