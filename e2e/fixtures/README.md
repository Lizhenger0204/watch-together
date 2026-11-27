# 片源測試 fixture

全部既有素材為 160 × 90 的小型測試素材，MP4 約 6 秒，MKV 為 2 秒，單檔小於 1 MB；另有一支 4K（3840 × 2160）H.264 + AAC 測試片（4 秒、約 0.85 MB）。所有 fixture 單檔須 ≤ 1 MB（git-workflow.md「禁止」）。

- `h264-aac.mp4`、`h264-silent.mp4`：既有 H.264 有聲／無聲片源。
- `h264-2160p-aac.mp4`：4K（3840 × 2160、30 FPS、4 秒）H.264 + AAC，供 `p2p-high-res.spec.ts` 驗證 2160P／原片不縮放與 1080P 縮放。
- `hevc-aac.mp4`：既有 HEVC Main、8-bit、`hvc1`、AAC LC。
- `hevc-main10-aac.mp4`：HEVC Main 10、10-bit、`hvc1`、AAC LC；不代表 HDR 或 Dolby Vision 驗證。
- `hevc-hev1-aac.mp4`：與既有 HEVC 片源相同位元流，改為 `hev1` tag。
- `hevc-aac.mkv`：HEVC Main、8-bit、AAC LC，取前 2 秒並降低影格率與碼率，以小型 Matroska 素材驗證容器路徑。
- `hevc-main10-aac.mkv`：HEVC Main 10、10-bit、AAC LC 的小型 Matroska 素材（2 秒、約 15 KB），供 Main 10 跨容器連續換片與清理測試使用。
- `hevc-main10-8bit-malformed-aac.mp4`：畸形 HEVC（`hvc1`，`hvcC` 與其 VPS／SPS 宣告 `general_profile_idc = 2` Main 10、`general_profile_compatibility_flag[1] = 0`，但 SPS 的 `bit_depth_luma_minus8 = 0`、`bit_depth_chroma_minus8 = 0`，實際畫面為 8-bit `yuv420p`；2 秒、約 19 KB）。
- `hevc-main10-8bit-malformed-aac.mkv`：畸形 HEVC MKV 版（`CodecPrivate` 與兩個關鍵幀前皆帶重複的 in-band VPS／SPS，全部宣告 Main 10 但實際 8-bit；2 秒、約 18 KB ≤ 20 KB）。
- `hevc-main10-8bit-fixed-aac.mp4`：由 `hevc-main10-8bit-malformed-aac.mp4` **免重新編碼**修補 `hvcC` 與 VPS／SPS 回到 Main（`general_profile_idc = 1`、`compat_flag[1] = 1`、`compat_flag[2] = 1`，經 EBSP↔RBSP 處理防偽零位元組）產生的修正版，解碼像素 MD5 與畸形版完全一致（`7603adce85ead7d180e5fc7a3ff680c7`）。
- `hevc-main10-8bit-fixed-aac.mkv`：由 `hevc-main10-8bit-malformed-aac.mkv` **免重新編碼**修補 `CodecPrivate` 與所有關鍵幀前重複 VPS／SPS 回到 Main 產生的修正版，解碼像素 MD5 與畸形版完全一致（`a938f2d00d5737ac5a085773e9dee771`）。

4K 測試片產生指令（crf 45、4 秒約 0.85 MB；E2E 會讓房主端循環播放）：

```sh
ffmpeg -f lavfi -i "testsrc2=size=3840x2160:rate=30" -f lavfi -i "sine=f=440:sample_rate=48000" -t 4 -c:v libx264 -preset veryfast -crf 45 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart e2e/fixtures/h264-2160p-aac.mp4
```

HEVC 變體由既有 `hevc-aac.mp4` 產生，沒有使用真實電影：

```sh
ffmpeg -i e2e/fixtures/hevc-aac.mp4 -c:v libx265 -pix_fmt yuv420p10le -tag:v hvc1 -x265-params log-level=error -c:a copy e2e/fixtures/hevc-main10-aac.mp4
ffmpeg -i e2e/fixtures/hevc-aac.mp4 -c copy -tag:v hev1 e2e/fixtures/hevc-hev1-aac.mp4
ffmpeg -i e2e/fixtures/hevc-aac.mp4 -t 2 -r 12 -c:v libx265 -pix_fmt yuv420p -x265-params crf=40:log-level=error -c:a aac -b:a 16k e2e/fixtures/hevc-aac.mkv
ffmpeg -i e2e/fixtures/hevc-aac.mp4 -t 2 -r 12 -c:v libx265 -pix_fmt yuv420p10le -x265-params crf=40:log-level=error -c:a aac -b:a 16k e2e/fixtures/hevc-main10-aac.mkv
```

T-138 畸形片（標成 Main 10、實際 8-bit）與免重編碼修正版製造方式（`libx265` 與 `hevc_videotoolbox` 都會拒絕把 8-bit 標成 Main 10，因此先產 8-bit Annex-B 位元流再改寫 VPS／SPS）：

1. 用 ffmpeg 產生含重複參數集（`keyint=12:repeat-headers=1`，共 2 個關鍵幀）的 2 秒 8-bit HEVC Annex-B 裸流與 16k AAC 音軌：
   ```sh
   ffmpeg -i e2e/fixtures/hevc-aac.mp4 -t 2 -r 12 -c:v libx265 -pix_fmt yuv420p -x265-params crf=40:keyint=12:min-keyint=12:repeat-headers=1:log-level=error -an -f hevc base.h265
   ffmpeg -i e2e/fixtures/hevc-aac.mp4 -t 2 -vn -c:a aac -b:a 16k audio.m4a
   ```
2. 以 Node 腳本拆出每個 VPS（NAL type 32）與 SPS（NAL type 33）→ EBSP 轉 RBSP（去防偽零位元組 `0x00 0x00 0x03`）→ 改寫 `profile_tier_level`（VPS 在 RBSP offset 4、SPS 在 offset 1）將 `general_profile_idc` 由 `1` 改為 `2`、`general_profile_compatibility_flags` 由 `0x60000000` 改為 `0x20000000`（不動 SPS 的 `bit_depth_luma_minus8 = 0`／`bit_depth_chroma_minus8 = 0`）→ RBSP 轉 EBSP → 輸出 `malformed.h265`。
3. 封裝畸形片：
   - MP4（`hvc1`，參數集在 `hvcC`）：`ffmpeg -r 12 -f hevc -i malformed.h265 -i audio.m4a -c copy -tag:v hvc1 -movflags +faststart e2e/fixtures/hevc-main10-8bit-malformed-aac.mp4`
   - MKV（先以 `-tag:v hev1` 保留關鍵幀前重複的 in-band VPS／SPS 再 `-c copy` 轉 MKV）：`ffmpeg -r 12 -f hevc -i malformed.h265 -i audio.m4a -c copy -tag:v hev1 tmp-hev1.mp4 && ffmpeg -i tmp-hev1.mp4 -c copy e2e/fixtures/hevc-main10-8bit-malformed-aac.mkv`
4. 免重編碼產生修正版：
   - `hevc-main10-8bit-fixed-aac.mp4`：由畸形 MP4 以純 Node 原型直接解析 `moov/.../hvcC`，經 EBSP↔RBSP 將 `hvcC` 標頭與內部 VPS／SPS 的 `general_profile_idc` 改回 `1`、`general_profile_compatibility_flags` 改回 `0x60000000`（並更新父層 box 長度與 `stco`/`co64`），不經 ffmpeg 重新編碼。
   - `hevc-main10-8bit-fixed-aac.mkv`：自畸形 MKV 以 `-c:v copy -bsf:v hevc_mp4toannexb` 抽出裸流，將 Extradata 與兩個關鍵幀前的 VPS／SPS 經 EBSP↔RBSP 全數改回 Main 後 `-c copy` 封回 MKV。
5. 以 `ffprobe -show_entries stream=profile,pix_fmt`、`ffmpeg -c:v copy -bsf:v trace_headers -f null -` 與 `ffmpeg -map 0:v:0 -f md5 -` 驗證：畸形片顯示 `profile=Main 10`＋`pix_fmt=yuv420p`，修正版顯示 `profile=Main`＋`pix_fmt=yuv420p`，且兩者解碼像素 MD5 完全一致。Windows 實機測試表見 [ADR 0006](../../docs/decisions/0006-hevc-main10-8bit-mismatch.md)。

`source.spec.ts` 的 HEVC 成功案例需要能原生解碼的真 Chrome：獨立 `<video>` 必須先產生影格並前進至少 1 秒，應用程式才可接受「檢查通過」並繼續實際播放。缺少平台解碼能力時，Playwright 會明示 skip 原因，並附上原生試播 JSON；略過不代表播放成功。

本機驗收執行 `HEVC_REQUIRED=1 WEB_PORT=5373 SIGNAL_PORT=8983 pnpm e2e e2e/source.spec.ts --project=chrome`，強制四種格式均需原生解碼與應用程式播放成功，缺能力時失敗，不能略過。一般 Linux CI 可依實際原生能力列出未驗證的成功案例，但仍必須執行不支援診斷與 H.264 的試播停滯回歸。

不支援案例另啟動帶 `--disable-features=PlatformHEVCDecoderSupport` 的 Chrome，先確認原生影像為 0，再驗證診斷；它不能代替成功案例。此旗標來自 [Chromium HEVC 平台功能定義](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/media_switches.cc)。
