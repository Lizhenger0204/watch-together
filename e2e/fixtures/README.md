# 片源測試 fixture

全部既有素材為 160 × 90 的小型測試素材，MP4 約 6 秒，MKV 為 2 秒，單檔小於 1 MB；另有一支 4K（3840 × 2160）H.264 + AAC 測試片（4 秒、約 0.85 MB）。所有 fixture 單檔須 ≤ 1 MB（git-workflow.md「禁止」）。

- `h264-aac.mp4`、`h264-silent.mp4`：既有 H.264 有聲／無聲片源。
- `h264-2160p-aac.mp4`：4K（3840 × 2160、30 FPS、4 秒）H.264 + AAC，供 `p2p-high-res.spec.ts` 驗證 2160P／原片不縮放與 1080P 縮放。
- `hevc-aac.mp4`：既有 HEVC Main、8-bit、`hvc1`、AAC LC。
- `hevc-main10-aac.mp4`：HEVC Main 10、10-bit、`hvc1`、AAC LC；不代表 HDR 或 Dolby Vision 驗證。
- `hevc-hev1-aac.mp4`：與既有 HEVC 片源相同位元流，改為 `hev1` tag。
- `hevc-aac.mkv`：HEVC Main、8-bit、AAC LC，取前 2 秒並降低影格率與碼率，以小型 Matroska 素材驗證容器路徑。
- `hevc-main10-aac.mkv`：HEVC Main 10、10-bit、AAC LC 的小型 Matroska 素材（2 秒、約 15 KB），供 Main 10 跨容器連續換片與清理測試使用。

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

`source.spec.ts` 的 HEVC 成功案例需要能原生解碼的真 Chrome：獨立 `<video>` 必須先產生影格並前進至少 1 秒，應用程式才可接受「檢查通過」並繼續實際播放。缺少平台解碼能力時，Playwright 會明示 skip 原因，並附上原生試播 JSON；略過不代表播放成功。

本機驗收執行 `HEVC_REQUIRED=1 WEB_PORT=5373 SIGNAL_PORT=8983 pnpm e2e e2e/source.spec.ts --project=chrome`，強制四種格式均需原生解碼與應用程式播放成功，缺能力時失敗，不能略過。一般 Linux CI 可依實際原生能力列出未驗證的成功案例，但仍必須執行不支援診斷與 H.264 的試播停滯回歸。

不支援案例另啟動帶 `--disable-features=PlatformHEVCDecoderSupport` 的 Chrome，先確認原生影像為 0，再驗證診斷；它不能代替成功案例。此旗標來自 [Chromium HEVC 平台功能定義](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/media_switches.cc)。
