# ADR 0002：房主瀏覽器直播，「轉發」與「P2P 直連」兩種模式並存

- 狀態：已採用（部分取代 ADR 0001；ADR 0001 已刪除，原文見 git 歷史）
- 日期：2026-11-24

## 背景

需求調查（使用者回覆）：

- 收看者主要在台灣，少數在中國大陸；每房 ≤ 8 人（房主 + 最多 7 位收看者）。
- 使用者與朋友都沒有伺服器、部署、Docker 經驗；不希望維護伺服器，也不想在伺服器上轉碼。
- 片源以電影為主：5–50 GB，常見 25 Mbps AI 放大片與 4K 藍光級影片。
- 朋友大多用 Windows，部分用 Android 手機；朋友也會當房主放片，且不會操作 OBS 這類工具。
- 房主網路：Wi-Fi 下載 400 / 上傳 110 Mbps；有線可跑滿方案頻寬。
- 擔心中國大陸收看者連不上海外轉發服務。
- 補充（同日）：片源統一為 **H.264 / H.265 + AAC**；一般 **3 位收看者**觀看；先完成實作，再實機測試。

ADR 0001 的「上傳到伺服器 → ffmpeg 轉 HLS → 分發」不適合：50 GB 上傳要等很久、4K 轉碼需要強力主機、分發流量成本高，而且需要有人維護伺服器。

## 決定

房主在**瀏覽器裡直接選本機影片播放**，網頁把正在播放的畫面即時用 WebRTC 送給收看者。不上傳檔案，伺服器不轉碼。

影片傳遞有**兩種模式，由房主在房間裡用選項卡切換**：

```
                       ┌─────────────── 模式 1：轉發（SFU）────────────────┐
房主瀏覽器               │  WHIP              Cloudflare Realtime     WHEP   │
<video src=本機檔案>  ───┼──────────────▶ SFU（只轉發不重壓）──────────────▶│ 每位收看者
captureStream()         │  只送 1 份                                         │
                       └──────────────────────────────────────────────────┘
                       ┌─────────────── 模式 2：P2P 直連（mesh）────────────┐
                       │  每位收看者一條 RTCPeerConnection，直接連到房主       │
                       │  連不上（嚴格 NAT）時改走 TURN 中繼                   │
                       └──────────────────────────────────────────────────┘

牽線伺服器（網頁、房間、邀請碼、WebRTC 信令、轉發模式的 WHIP/WHEP 轉接）
  → 用 Hono 撰寫，同一份程式可部署在 Cloudflare Workers + Durable Objects，或香港小主機（Node）
```

### 兩種模式比較

| | 轉發（SFU） | P2P 直連 |
| --- | --- | --- |
| 房主上傳 | 1 份 | 每位收看者 1 份 |
| 房主電腦編碼 | 1 份 | N 份 |
| 每人畫質 | 所有人同一種 | 每條連線各自調整 |
| 中國大陸 | 連到 Cloudflare 境外節點 | 直連房主；連不上時走中繼 |
| 費用 | 每月 1,000 GB 免費，之後 $0.05/GB | 幾乎免費（只有走中繼的流量） |
| 適用 | 房主頻寬或電腦效能不足、收看者多 | 頻寬足夠、有中國大陸收看者 |

### 模式切換規則

- 建房時預設 **P2P 直連**（使用者頻寬足夠，且最在意中國大陸收看者）。
- 房主可隨時切換；切換時所有收看者會重新連線，畫面中斷幾秒。
- 之後可擴充「每位收看者各自模式」（例如台灣走轉發、大陸走 P2P），MVP 不做。

### 技術選擇

| 層 | 選擇 | 取代 ADR 0001 的 |
| --- | --- | --- |
| 影片傳遞 | WebRTC（轉發模式用 WHIP/WHEP；P2P 模式用自建信令） | tus 上傳 + ffmpeg + HLS |
| 轉發服務 | Cloudflare Realtime SFU | 自架 Node 伺服器分發 |
| 牽線伺服器 | Hono；第一優先部署在 Cloudflare Workers + Durable Objects（自訂網域），中國大陸連不到時搬到香港小主機 | Fastify + Socket.IO |
| WHIP/WHEP 轉接 | 參考 Cloudflare 官方 `realtime-examples/whip-whep-server` 改寫 | — |
| STUN | Cloudflare STUN，再加一個中國大陸可用的 STUN（**不可只用 Google STUN**，大陸連不到） | — |
| TURN 中繼 | 先用 Cloudflare TURN；大陸收看者連不上時，在香港主機架 coturn | — |
| 前端 | 沿用 Vite + React + TypeScript | — |
| 共用 | 沿用 pnpm workspace、zod、Vitest、Playwright | — |

### 平台範圍（MVP）

- 房主：桌面版 Chrome 或 Edge（Windows / macOS），**建議用有線網路**（Wi-Fi 抖動會讓所有收看者一起卡）。Safari 不支援 `HTMLMediaElement.captureStream()`，不能當房主；Android 當房主不在 MVP。
- 收看者：任何支援 WebRTC 的現代瀏覽器，包括 Android Chrome 與 Safari。

## 頻寬估算（房主上傳 110 Mbps 的 Wi-Fi）

| 模式 | 1080p 6 Mbps × 7 人 | 1080p 8 Mbps × 7 人 | 4K 15 Mbps × 7 人 |
| --- | --- | --- | --- |
| 轉發 | 6 Mbps | 8 Mbps | 15 Mbps |
| P2P | 42 Mbps | 56 Mbps | 105 Mbps（太接近上限，不建議） |

P2P 預設上限：每條連線 8 Mbps，總和不超過房主上傳的 70%（例如 110 Mbps 時約 77 Mbps）。

## 理由

- **不用等**：選完檔案就能開播，50 GB 的片也一樣。
- **不用管伺服器**：第一優先全部託管在 Cloudflare；只有中國大陸連不到時才需要香港小主機（每月約 5 美元）。
- **兩種模式互補**：轉發省房主頻寬、P2P 避開海外轉發節點。兩者約八成程式共用（房間、邀請碼、選片、播放器），只有傳輸層不同。
- **自然同步**：所有人看同一條即時串流，延遲差小於 1 秒，不需要時鐘校正與漂移校正。
- **朋友零安裝**：房主與收看者都只用瀏覽器。

## 代價與已知限制

1. **格式受房主瀏覽器限制**。片源已約定為 H.264 / H.265 + AAC，音訊不成問題；剩下的風險是 HEVC 需要房主電腦有硬體解碼，以及 mkv 容器在 Chrome / Edge 只有非正式支援。網頁必須在開播前檢查並清楚告知。
2. **畫質會被重新壓縮**。預設 1080p、6–8 Mbps。
3. **房主分頁必須保持開啟**，房主電腦負責解碼與編碼。
4. **P2P 模式下房主電腦要同時編碼 N 份**，人多時顯示卡或 CPU 可能吃不消，需實測。
5. **收看者不能各自拖進度**，播放、暫停、拖進度都由房主操作。
6. **中國大陸沒有保證**：轉發模式連到境外節點；P2P 模式受跨境網路品質影響；牽線伺服器放在 Cloudflare 時大陸能否連上也未知。

## 後續（第二階段，依實測結果決定）

- 若實測發現常有播不了的片：小幫手 App（內含 ffmpeg 8+，`-f whip`）。
- 每位收看者各自選模式（混合模式）。

## 待驗證清單（實作完成後的人工驗收，T-113）

| 項目 | 要確認什麼 |
| --- | --- |
| Windows Chrome / Edge 的 HEVC（含 10-bit） | 硬體解碼能否播放，`captureStream()` 能否擷取 |
| Chrome / Edge 開 mkv（H.264 / HEVC + AAC） | 能否播放；不行就提示改用 mp4 |
| 房主端靜音 / 音量 | 是否影響推出去的音訊 |
| 房主分頁切到背景或最小化 | 推流是否中斷或掉幀 |
| P2P 同時 7 條 1080p 連線 | 房主電腦的 CPU / GPU 負擔、是否掉幀 |
| 中國大陸收看者 | Cloudflare 上的網頁能否打開；P2P 直連成功率；兩種模式各自可接受的碼率 |
| `whip-whep-server` 範例 | 授權條款、維護狀態、能否直接改寫成房間制 |

## 來源

- [Cloudflare Realtime SFU pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
- [Cloudflare Realtime TURN FAQ（中國大陸路由）](https://developers.cloudflare.com/realtime/turn/faq/)
- [Cloudflare Realtime demos](https://developers.cloudflare.com/realtime/sfu/demos)
- [Cloudflare China Network：Available products](https://developers.cloudflare.com/china-network/reference/available-products)
- [caniuse: HTMLMediaElement.captureStream](https://caniuse.com/mdn-api_htmlmediaelement_capturestream)
