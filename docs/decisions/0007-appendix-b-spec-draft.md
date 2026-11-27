# ADR 0007 附錄 B：協定與封裝草稿（T-140）

> **草稿（T-140）**：ADR 0007 採用前沒有效力，現行 `streaming.md`、`protocol.md`、`packages/shared` 不變。採用後由 T-141～T-144 依序搬進正式規格（先改規格與 shared，再改實作）。同步、背壓與選層規則見附錄 C。

## §1 頻道與識別碼

- 只在 **P2P 模式**使用。房主建立每位收看者的 `RTCPeerConnection` 時，在第一次 offer 前開 `pt-ctl`（JSON，可靠有序）。資料頻道 `pt-data`（二進位，可靠有序，`binaryType = 'arraybuffer'`）由房主另開，可在同一連線上替換。
- 識別碼：

  | 識別 | 意義 | 何時更新 |
  | --- | --- | --- |
  | 連線 | 這條 `RTCPeerConnection` 及其頻道 | 重建連線（房主或收看者重連、切模式）。舊連線的頻道全部關閉，回呼以物件身分判斷後忽略 |
  | `config` | 片源＋層級＋封裝組態（MIME、init segment、時間位移） | 換片、換層、第二層換畫質、第二層編碼器 `decoderConfig` 改變、`hvc1` 改為 `hev1` 等。每個 config 有自己的 init segment 與 SourceBuffer 組 |
  | `epoch` | 同一 config 內的定位 | 房主跳轉、對這位收看者重新定位 |
  | `dataId` | 目前有效的 `pt-data`（其 `RTCDataChannel.id`） | 開新的 `pt-data`（附錄 C §4 排空逾時） |

  `config`、`epoch` 為房主配發的遞增整數，在同一連線內不重複。
- **ICE restart**（同一連線）：識別碼不變；收看端重新對時。中斷超過 5 秒才恢復時，房主為這位收看者開新 epoch。
- 版本：`PASSTHROUGH_VERSION = 1`，在 `hello` 中；不一致就走第三層。

## §2 二進位分塊（`pt-data`）

每則 = 16 bytes 標頭＋資料，整則 ≤ `min(64 KiB, sctp.maxMessageSize)`。欄位 big-endian：

| 位移 | 長度 | 欄位 | 說明 |
| --- | --- | --- | --- |
| 0 | 1 | `kind` | 1 = init segment，2 = 入口片段，3 = 續接片段 |
| 1 | 1 | `track` | 0 = 影像，1 = 音訊 |
| 2 | 2 | `count` | 這個片段共幾塊，1～256 |
| 4 | 4 | `config` | |
| 8 | 4 | `epoch` | init 也帶當次 epoch（§4 第 5 步） |
| 12 | 2 | `seq` | 片段序號（16 位元，回繞）；同一片段的塊相同 |
| 14 | 2 | `index` | 0 起 |

規則：

- 收看端只接受目前 `dataId` 頻道上、`(config, epoch)` 等於目前已 `ready` 那一組的塊（init 也一樣）；其他一律丟棄，也不計入累計值。**房主只在收到對應的 `ready` 之後才送資料**（§4），所以正常情況不會有資料先於宣告到達。
- 同一片段的塊必須連續、`index` 依序、`count` 不變；`index = count − 1` 即完成。片段未完成就換了 `(kind, track, seq)` → 丟棄未完成部分（房主跳轉時會中途放棄）。
- 片段上限：一般 4 MiB。單一 sample 超過 4 MiB 時自成一段，上限 = `256 × (每則大小 − 16)`（每則 64 KiB 時約 16 MiB − 4 KiB）；更大的 sample 無法送出，該片源停用第一、二層。
- 收看端的組裝中與待附加資料共用 16 MiB 硬上限。標頭不合法、`count` 超限、`index` 跳號、超過硬上限 → 協定錯誤（§7）。

## §3 輸出時間軸

**定義**：輸出時間軸 = 房主 `<video>` 的呈現時間軸（套用 edit list 之後）。收看端 `currentTime` 與房主 `currentTime` 直接可比。

- **MP4／MOV**：從 `stts`／`ctts` 取每個 sample 的來源 DTS、CTS 與 duration。只支援下列 edit list，其他（多段、`media_rate ≠ 1`、中間空白段）該片源停用第一、二層：
  - 沒有 edit list：`偏移 M = 0`；
  - 一段 media edit（`media_time = M`、長度 `U`），前面可有一段起始空白（長 `E`）：`輸出 PTS = CTS − M + E`、`輸出 DTS = DTS − M + E`。只送輸出 PTS 落在 `[E, E + U)` 的 sample：PTS < E 的影像 sample 視為入口前導（見下方入口規則）處理，PTS ≥ E + U 的不送；音訊照下方 priming 規則。
  - 影像與音訊各自依自己的 edit 計算。mediabunny 的 `packet.timestamp` 應等於輸出 PTS，T-141 以單元測試核對兩者，不一致時以本節為準。
- **MKV**：容器只有 PTS（區塊時間），視為輸出 PTS。DTS 推導：依解碼順序第 i 個 sample 的 `DTS_i = 全軌 PTS 由小到大排序後的第 i 個值 − D`。重排深度上限 16，所以只需往後看 16 個 sample；`D` = 使前 5 個 GOP 都滿足 `DTS ≤ PTS` 的最小值，之後固定。可接受條件（每個片段都檢查）：沒有重複 PTS（否則會出現零長度 sample）、`DTS_i ≤ PTS_i`、`DTS_i + duration_i = DTS_{i+1}`（誤差 ≤ 1 ms，含跨片段的最後一個與下一段第一個）、重排深度 ≤ 16。不符合就停用該片源的第一、二層。
- **封裝時間與位移**：`O = max(0, −全片最小輸出 DTS)`，取 timescale 的整數。**封裝時間 = 輸出時間 + O**，寫進 `tfdt`（解碼時間）；`trun` 的 composition offset = `PTS − DTS`（O 互相抵銷）。收看端每個 SourceBuffer 設 `timestampOffset = −O`；`appendWindowStart`／`appendWindowEnd` 一律以**輸出時間**表示（不含 O）。
- **音訊 priming**：輸出 PTS < 0 的音訊 sample（AAC priming）由 `appendWindowStart = 0` 去掉；跨過 0 的 sample 由瀏覽器裁切（Chrome 會做部分裁切；Safari 未驗證，列入 T-113）。這與房主 `<video>` 的行為一致。
- **入口**：H.264 只用 IDR（open GOP 的非 IDR I 幀不當入口，因為其前導 B 幀可能被後面的畫面參照）；HEVC 用 IDR、BLA、CRA。
- **前導畫面在封裝時就去掉，不靠 `appendWindowStart`**：從入口開始的那一段，依解碼順序在入口之後、輸出 PTS 早於入口 PTS 的影像 sample（HEVC 的 RASL／RADL、H.264 IDR 不會有）**不放進片段**。HEVC 規範保證後續畫面不參照前導畫面，所以可以安全移除；若用 `appendWindowStart` 讓 MSE 丟棄，MSE 會設「需要隨機進入點」，連後面有效的畫面也一起丟掉（[MSE coded frame processing](https://w3c.github.io/media-source/#sourcebuffer-coded-frame-processing)）。影像 SourceBuffer 的 `appendWindowStart` 一律為 0、`appendWindowEnd` 為片尾。
- **續接片段**：GOP 內的後續 sample，不必以關鍵影格開頭。音訊片段約 1 秒，每個都可當入口。
- **驗收**：T-141 用 VFR＋B 幀的 H.264、含 RASL 的 HEVC CRA（從 CRA 入口開始）、AAC priming、帶 edit list 的 MP4 四種素材，在 Chrome 實際附加後檢查 `buffered` 連續、入口後沒有畫面被丟（`totalVideoFrames` 與預期相同）、首格時間與房主 `<video>` 相同、影音對齊誤差 < 1 格。

## §4 `pt-ctl` 訊息與握手

**握手**（所有期限從房主送出起算）：

1. 頻道開啟 → 收看端 5 秒內送 `hello`。
2. 房主送 `probe { config, video, audio }` → 收看端 3 秒內回 `probeResult`。快速連換片時，只有最後一個 config 的回覆有效。
3. 房主決定層級後送 `config { config, tier, video?, audio?, offset }`（`live` 時沒有 MIME，收看端改用 `srcObject`）。收看端建立 MediaSource 與該 config 的 SourceBuffer。
4. 房主送 `position { config, epoch, dataId, entry }`（`entry` = 入口的輸出時間，附錄 C §3）。收看端清掉該 config 的緩衝、套用 `appendWindowStart`，然後回 `ready { config, epoch, dataId }`。新 config 為 5 秒內，同一 config 的新 epoch 為 3 秒內。
5. 房主收到相符的 `ready` 才開始送這組資料，**每次都先送一份帶當次 `(config, epoch)` 的 init segment**，再送入口片段。重複附加相同的 init 對 MSE 無害；這樣跳轉或換頻道時，送到一半的舊 init 被丟棄也不會漏掉。
6. 收看端建立 MediaSource、SourceBuffer 或附加失敗時送 `fail { config, reason }`；房主把這位收看者降一層。

任一步逾期 → 降一層（第一、二層 → 第三層）。換 `pt-data` 也走第 4 步（新的 `dataId`），收看端收到 `position` 後才接受新頻道的資料。

收看端 → 房主：

| type | 內容 |
| --- | --- |
| `hello` | `{ version, caps: { mse: 'mse' \| 'managed' \| 'none', h264: boolean, platform } }` |
| `ping` | `{ t0 }` |
| `probeResult` | `{ config, video: boolean, audio: boolean }` |
| `ready` | `{ config, epoch, dataId }` |
| `fail` | `{ config, reason }` |
| `status` | `{ config, epoch, dataId, presentedTime, receivedBytes, appendedBytes, aheadBytes, aheadSeconds, buffered: { video, audio }, state: 'buffering' \| 'playing' \| 'paused' \| 'stuck', driftMs }`；`buffered` 每軌最多 4 段 `[start, end]`（輸出時間） |
| `quota` | `{ config, epoch }` |
| `streaming` | `{ config, on: boolean, buffered? }` |
| `retry` | `{ config }` |

房主 → 收看端：

| type | 內容 |
| --- | --- |
| `pong` | `{ t0, t1 }` |
| `probe` | `{ config, video, audio }`（候選 MIME，含 codecs；無聲片沒有 `audio`） |
| `config` | `{ config, tier: 'passthrough' \| 'transcode' \| 'live', reason?, video?, audio?, offset }` |
| `position` | `{ config, epoch, dataId, entry }` |
| `state` | `{ config, epoch, playing, mediaTime, hostClock, rate }` |

- 房主只採用 `(config, epoch, dataId)` 都是目前值的 `status`；累計值的檢查見附錄 C §4。
- **控制頻道背壓**：單則 ≤ 16 KiB。`pt-ctl` 的 `bufferedAmount` > 16 KiB 時，雙方都不再排入可替換的訊息（`status`、例行 `state`、`ping`），只保留最新一份待送；不可替換的訊息（`config`、`position`、`ready`、`fail`、`quota`）照送。
- 速率上限：每個方向每秒 100 則（含恢復後集中送達的量）；收看端送出房主專用 type（或反之）計一次違規，3 次即協定錯誤。

## §5 Sample entry 與 codec 字串

| 片源 | sample entry | 設定 box | codec 字串 |
| --- | --- | --- | --- |
| H.264 | `avc1` | `avcC` | `avc1.PPCCLL`（取自 `avcC`） |
| HEVC | `hvc1` 或 `hev1`（規則見下） | `hvcC` | 前綴與 sample entry 相同 |
| AAC | `mp4a`（OTI 0x40） | `esds` | `mp4a.40.<AOT>` |
| MP3 | `mp4a`（OTI 0x6B） | `esds` | `mp4a.6B` |
| Opus | `Opus` | `dOps` | `opus` |
| FLAC | `fLaC` | `dfLa` | `flac` |

**HEVC 的 `hvc1`／`hev1`**（mediabunny 的 codec 字串一律回報 `hev1`，不能用它判斷）：

- 預設封成 **`hev1`**，樣本內的參數集原樣保留。Chrome、Android、Firefox 收看者用這個 config。
- 收看端只收 `hvc1`（`probeResult` 顯示 `hev1` 不支援、`hvc1` 支援，例如 Safari）時，另開一個 `hvc1` config 給他：封裝時逐樣本檢查，**與 `hvcC` 位元組完全相同**的 VPS／SPS／PPS NAL 從樣本中移除；遇到不同的參數集就無法維持 `hvc1`，該收看者降層。
- MP4 來源本來就是 `hvc1` 時同樣逐樣本檢查（規範上不應有樣本內參數集，有就照上一條處理）。

**T-138**：`features/source/`（GPT）對外提供 T-138 的偵測結果與「按需修補」函式。偵測為「標頭 Main 10、實際 8-bit」時，**不論房主本機是否能直接播**，拆檔器都讀修正後的零複製 Blob（房主本機仍可播原檔）。修補不可用（T-138 的降級條件）時照常送原片；收看端解碼失敗就回 `fail`，該收看者降層。

**第二層輸出**：`VideoEncoder` 設 `avc: { format: 'avc' }`（length-prefixed，與 MP4 樣本格式相同；原型用的 Annex B 只是為了解析 QP）。`avcC` 與 codec 字串取自輸出 metadata 的 `decoderConfig`；`decoderConfig` 中途改變（例如編碼器重設）就開新 config。

**音訊**：選第一條收看端支援的音軌；AC-3／E-AC-3／DTS／TrueHD 依 ADR 待決 2 處理；全部不支援就只送影像並提示。

## §6 房主上傳（P2P，Mbps，穩態 1.0～1.5 倍）

| 片源 | 1 人 | 3 人 | 7 人 |
| --- | --- | --- | --- |
| 1080P 8 Mbps | 8～12 | 24～36 | 56～84 |
| 4K 25 Mbps | 25～38 | 75～113 | 175～263 |
| 4K 40 Mbps | 40～60 | 120～180 | 280～420 |

實際以附錄 C §5 的房間預算分配。

## §7 退路與協定錯誤

| 情況 | 處理 |
| --- | --- |
| `pt-ctl` 10 秒內沒打開、SCTP 被拒 | 該收看者第三層（媒體軌照舊） |
| 握手任一步逾期、`fail` | 降一層 |
| 版本不符、協定錯誤（§2、§4、附錄 C §4 的累計值檢查） | 關閉 `pt-ctl` 與 `pt-data`，第三層；同一連線不再嘗試 |
| 入口送出後 10 秒沒開播 | 降一層（附錄 C §3） |
| 收看者被踢、離開、連線結束 | 房主關閉連線與頻道，丟棄該收看者的所有狀態 |

## §8 `protocol.md` 草稿變動

- `MemberStatus` 加選填欄位（`memberStatusSchema` 是 `z.object`，舊版略過未知欄位，**不升版**）：`tier?: 'passthrough' | 'transcode' | 'live'`、`driftMs?: number`（正值＝收看端超前房主）。
- **伺服器要改**：`apps/signal/src/signaling/process.ts` 目前逐欄重組 `member:status` 再轉給房主，要加上這兩欄。
- **是否升版依向後相容判斷**：`roomInfoSchema` 本身是 `z.object`（舊版略過新欄位），但 `qualitySchema` 是 `strictObject`。在 `RoomInfo` 加新的選填欄位不必升版；改動 `Quality` 或讓舊版會誤判的欄位才升 `PROTOCOL_VERSION = 3`。

## §9 `streaming.md` 草稿變動

1. **新增 §10「原片直送」**：ADR D2～D6、本附錄與附錄 C。
2. **§2 畫質**：選「原片」或不低於片源 → 第一層；低於片源 → 第二層；第三層才用 `scaleResolutionDownBy`。畫質面板新增「上傳頻寬」。
3. **§3 P2P**：房主在第一次 offer 前開 `pt-ctl`；第一、二層收看者的媒體暫停規則（附錄 C §5）。
4. **§6 模式切換**：切到轉發時全部第三層；切回 P2P 時重新分配。
5. **§7 收看端播放**：`passthrough`／`transcode` 用 MediaSource（iOS 用 ManagedMediaSource 並設 `disableRemotePlayback = true`），`live` 用 `srcObject`；切換前先清掉另一種來源。「點擊開始觀看」不變。
6. **§8 統計**：`member:status` 帶 `tier`、`driftMs`；第一、二層的 `bitrateKbps` 取 `pt-data` 收到速率。
7. **§9 傳輸層契約**：房主端每位收看者的 DataChannel 掛勾、媒體暫停旗標；收看端暴露 DataChannel。介面在 T-141 由 Claude 與 GPT 協調定案（ADR D10）。
