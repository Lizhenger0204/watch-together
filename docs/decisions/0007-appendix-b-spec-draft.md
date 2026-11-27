# ADR 0007 附錄 B：協定與封裝草稿（T-140）

> **草稿（T-140）**：ADR 0007 採用前沒有效力，現行 `streaming.md`、`protocol.md`、`packages/shared` 不變。採用後由 T-141～T-144 依序搬進正式規格（先改規格與 shared，再改實作）。同步、背壓與選層規則見附錄 C。

## §1 頻道與識別碼

- 只在 **P2P 模式**使用。房主為每位收看者建立 `RTCPeerConnection` 時，在第一次 offer 前開兩條 DataChannel：

  | label | 設定 | 內容 |
  | --- | --- | --- |
  | `pt-ctl` | 可靠、有序 | JSON 文字訊息（§4） |
  | `pt-data` | 可靠、有序，`binaryType = 'arraybuffer'` | 二進位分塊（§2） |

- 三層識別碼，所有訊息都帶上（資料塊帶 `config`、`epoch`；`session` 由頻道物件本身代表）：

  | 識別 | 意義 | 何時更新 |
  | --- | --- | --- |
  | `session` | 這條 P2P 連線（含其 DataChannel） | 重建 `RTCPeerConnection`（房主重連、收看者重連、切模式）。舊連線的頻道一律關閉，舊回呼以物件身分判斷後忽略 |
  | `config` | 片源＋層級＋編碼組態（MIME 與 init segment） | 換片、換層（第一 ↔ 第二）、第二層換畫質。**每個 config 有自己的 init segment 與 SourceBuffer 組** |
  | `epoch` | 同一 `config` 內的定位 | 房主跳轉、對這位收看者重新定位（附錄 C §3） |

  `config` 與 `epoch` 都是 32 位元遞增整數，由房主配發，在同一 `session` 內不重複。
- **ICE restart**（同一條連線）：`session` 不變、頻道不重開；收看端重新對時（附錄 C §1）。中斷超過 5 秒才恢復時，房主為這位收看者開新 `epoch`（重新定位）。
- `pt-data` 排空逾時（附錄 C §4）時，房主關閉它並開新的 `pt-data`（label 相同、新 id），收看端收到新頻道後丟棄舊頻道的所有資料。
- 版本：`PASSTHROUGH_VERSION = 1`，在 `hello` 中。不一致就該收看者走第三層。

## §2 二進位分塊（`pt-data`）

每則 = 20 bytes 標頭＋資料，整則 ≤ `min(64 KiB, sctp.maxMessageSize)`。欄位 big-endian：

| 位移 | 長度 | 欄位 | 說明 |
| --- | --- | --- | --- |
| 0 | 1 | `kind` | 1 = init segment，2 = 入口片段，3 = 續接片段 |
| 1 | 1 | `track` | 0 = 影像，1 = 音訊 |
| 2 | 2 | 保留 | 0 |
| 4 | 4 | `config` | |
| 8 | 4 | `epoch` | init 為 0 |
| 12 | 4 | `seq` | 同一 `session` 內遞增 |
| 16 | 2 | `index` | 從 0 起 |
| 18 | 2 | `count` | ≥ 1 |

**組裝規則與上限**：

- 同一片段的塊必須連續到達、`index` 從 0 依序遞增、`count` 不變；`index = count − 1` 即完成。`(config, epoch, seq, kind, track)` 改變而上一片段未完成 → 丟棄未完成的部分（房主跳轉時會中途放棄）。
- 單一片段 ≤ 32 MiB（`count ≤ 512`）；收看端待附加總量 ≤ 16 MiB（附錄 C §4）。標頭不合法、`count` 超限、`index` 跳號 → 關閉頻道，該收看者改第三層。
- `config` 不是收看端目前的 config：若是房主 `tier` 剛宣告、收看端還在建立 SourceBuffer 的 config，暫存（≤ 8 MiB）；其他一律丟棄。init segment 只對**同一 config** 保留，跨 config 不沿用。
- 媒體片段 `epoch` 小於目前值就丟棄；大於目前值時，只有在已收到該 config 的 `tier` 之後才切換（`pt-data` 可能比 `pt-ctl` 先到）。

## §3 時間軸

- **PTS** 用 mediabunny 的 `packet.timestamp`（已套用 edit list，與房主 `<video>` 的呈現時間一致；附錄 A §1 的 `h264-aac.mp4` 音訊首包為 −23.22 ms）。
- **DTS**：
  - MP4／MOV：讀 `stts`（解碼時間差）與 `ctts`（組成偏移）取得每個 sample 的來源 DTS 與 duration（mediabunny 不提供，T-141 自己讀 `moov`，或向 mediabunny 提需求）。
  - MKV：容器沒有 DTS。以整條軌估一個固定重排延遲 `D`（掃描前 5 個 GOP，`D` = 使 `DTS_i = 第 i 個（依解碼順序）PTS 排序值 − D` 滿足 `DTS_i ≤ PTS_i` 的最小值），之後每個片段檢查：與上一片段的解碼時間是否連續（差 ≤ 1 ms）、`DTS ≤ PTS`。檢查失敗 → 該片源第一、二層停用，改第三層。
- **原型的「片段內 PTS 排序」不可用**：GPT 以 VFR＋open GOP 的 H.264 樣片實測，第 4 段解碼時間結束於 8.250 秒、第 5 段 `tfdt` 從 8.333 秒開始，出現 83 ms 缺口。
- **負時間戳**：全片取固定位移 `O = max(0, −最小 DTS)`（四捨五入到 timescale），所有 `tfdt` 加 `O`；收看端在每個 SourceBuffer 設 `timestampOffset = −O`。`O` 放在 `tier` 訊息。
- **入口片段**：以可隨機進入的影格開頭（H.264 IDR 或 recovery point 為 0 的 I 幀；HEVC IRAP）。收看端從入口開始附加時，設 `appendWindowStart = 入口 PTS − O`，去掉 open GOP 與 HEVC CRA 的前導畫面（RASL）；之後的續接片段把 `appendWindowStart` 設回 0。
- **續接片段**：GOP 內的後續部分，不必以關鍵影格開頭。影像片段長度 ≤ 2 秒；GOP 比 2 秒長時，一個 GOP 是 1 個入口片段＋若干續接片段。音訊片段約 1 秒，全部當入口（音訊每個 sample 都可進入）。

## §4 `pt-ctl` 訊息

所有訊息都有 `type`，除 `hello`、`ping`、`pong` 外都帶 `config`（收看端尚未收到任何 config 時填 0）；`state`、`status`、`ready` 另帶 `epoch`。單則 ≤ 16 KiB；每個方向每秒最多 50 則，超過就關閉頻道改第三層。收看端送出房主專用的 type（或反之）一律忽略並計一次違規，3 次即關閉。

收看端 → 房主：

| type | 內容 | 時機 |
| --- | --- | --- |
| `hello` | `{ version, caps: { mse: 'mse' \| 'managed' \| 'none', h264: boolean, platform } }` | 頻道開啟後第一則，5 秒內必須送出 |
| `ping` | `{ t0 }` | 附錄 C §1 |
| `probeResult` | `{ config, video: boolean, audio: boolean }` | 收到 `probe` 後 |
| `ready` | `{ config, epoch }` | 該 config 的 SourceBuffer 都建立好；房主只對目前的 config 開始傳送 |
| `status` | `{ config, epoch, presentedTime, appendedBytes, aheadBytes, aheadSeconds, state, quotaHits, driftMs }` | 每 250 ms |
| `quota` | `{ config, epoch }` | 附錄 C §4 |
| `streaming` | `{ config, on: boolean }` | ManagedMediaSource 的 `startstreaming`／`endstreaming` |
| `retry` | `{ config }` | 收看者按「重試原片」 |

房主 → 收看端：

| type | 內容 | 時機 |
| --- | --- | --- |
| `pong` | `{ t0, t1 }` | 收到 `ping` |
| `probe` | `{ config, video, audio }`（候選 MIME，含 codecs） | 收到 `hello` 後、換片時；每次 probe 都用新的 config |
| `tier` | `{ config, tier: 'passthrough' \| 'transcode' \| 'live', reason?, video?, audio?, offset? }` | 決定或改變層級；`video`／`audio` 為 SourceBuffer 的 MIME（無聲片沒有 `audio`），`offset` 即 §3 的 `O`。`live` 時收看端停用 MSE、改用 `srcObject` |
| `state` | `{ config, epoch, playing, mediaTime, hostClock, rate }` | 附錄 C §1 |

- `probeResult`、`ready`、`status` 的 `config` 不是房主目前的 config 就忽略。快速連換兩片時，只有最後一次 `probe` 的回覆有效。
- `aheadBytes`：SourceBuffer 中「應在時間之後」的估計位元組（收看端依附加時記錄的片段大小與時間範圍計算）。

## §5 Sample entry 與 codec 字串

| 片源 | sample entry | 設定 box | codec 字串 |
| --- | --- | --- | --- |
| H.264 | `avc1` | `avcC` | `avc1.PPCCLL`（取自 `avcC`） |
| HEVC，MP4 來源 | 沿用來源 `stsd` 的 `hvc1` 或 `hev1` | `hvcC` | `hvc1.*`／`hev1.*`，前綴與 sample entry 相同 |
| HEVC，MKV 來源 | 抽查首個與中段入口的位元流：沒有參數集，或與 `CodecPrivate` 完全相同 → `hvc1`；否則 `hev1` | `hvcC`（= `CodecPrivate`） | 同上 |
| AAC | `mp4a`（OTI 0x40） | `esds` | `mp4a.40.<AOT>` |
| MP3 | `mp4a`（OTI 0x6B） | `esds` | `mp4a.6B` |
| Opus | `Opus` | `dOps` | `opus` |
| FLAC | `fLaC` | `dfLa` | `flac` |

- T-138 偵測為「標頭 Main 10、實際 8-bit」時，`hvcC` 取自修正後的 Blob（ADR D5）。
- 第二層輸出用 `VideoEncoder` output metadata 的 `decoderConfig.codec` 與 `description`（`avcC`），不自己猜。
- AC-3／E-AC-3／DTS／TrueHD：不送原音軌，依 ADR 待決 2 處理；選第一條收看端支援的音軌。

## §6 房主上傳（P2P，Mbps，穩態 1.0～1.5 倍）

| 片源 | 1 人 | 3 人 | 7 人 |
| --- | --- | --- | --- |
| 1080P 8 Mbps | 8～12 | 24～36 | 56～84 |
| 4K 25 Mbps | 25～38 | 75～113 | 175～263 |
| 4K 40 Mbps | 40～60 | 120～180 | 280～420 |

實際以附錄 C §5 的房間預算分配；放不下的人改第二、三層。

## §7 退路與期限

| 情況 | 處理 |
| --- | --- |
| DataChannel 10 秒內沒打開、SCTP 被拒 | 該收看者第三層（媒體軌照舊） |
| 開啟後 5 秒沒收到 `hello`（例如舊版網頁） | 第三層 |
| 版本不符、協定違規（§2、§4） | 關閉兩條 DataChannel，第三層 |
| 開始傳送後 10 秒沒開播 | 降一層（附錄 C §3） |
| 收看者被踢、離開、`session` 結束 | 房主關閉連線與頻道，丟棄該收看者的所有狀態 |

## §8 `protocol.md` 草稿變動

- `MemberStatus` 加選填欄位（`memberStatusSchema` 是 `z.object`，舊版略過未知欄位，**不升版**）：

  ```ts
  type MemberStatus = {
    state: 'waiting' | 'connecting' | 'playing' | 'buffering' | 'failed';
    bitrateKbps?: number;
    rttMs?: number;
    packetLoss?: number;
    tier?: 'passthrough' | 'transcode' | 'live'; // 草稿（T-140）
    driftMs?: number; // 草稿（T-140）：正值＝收看端超前房主
  };
  ```

- **伺服器要改**：`apps/signal/src/signaling/process.ts` 目前逐欄重組 `member:status` 再轉給房主，要加上 `tier`、`driftMs`。
- 若之後在 `RoomInfo`（strict）加入「傳送方式」等房間設定，才升 `PROTOCOL_VERSION = 3`。

## §9 `streaming.md` 草稿變動

1. **新增 §10「原片直送」**：ADR D2～D6、本附錄與附錄 C。
2. **§2 畫質**：選「原片」或不低於片源 → 第一層；低於片源 → 第二層；第三層才用 `scaleResolutionDownBy`。畫質面板新增「上傳頻寬」。
3. **§3 P2P**：房主在第一次 offer 前開 §1 的頻道；第一、二層收看者的 sender `replaceTrack(null)`。
4. **§6 模式切換**：切到轉發時全部第三層；切回 P2P 時重新分配（附錄 C §5）。
5. **§7 收看端播放**：`passthrough`／`transcode` 用 MediaSource（iOS 用 ManagedMediaSource 並設 `disableRemotePlayback = true`），`live` 用 `srcObject`；切換前先清掉另一種來源。「點擊開始觀看」不變。
6. **§8 統計**：`member:status` 帶 `tier`、`driftMs`；第一、二層的 `bitrateKbps` 取 `pt-data` 收到速率。
7. **§9 傳輸層契約**：房主端每位收看者的 DataChannel 掛勾、sender 停送與恢復；收看端暴露 DataChannel。介面在 T-141 由 Claude 與 GPT 協調定案（ADR D10）。
