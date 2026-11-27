# ADR 0007 附錄 F：片段請求協定草稿（T-140）

> **草稿（T-140）**：ADR 0007 採用前沒有效力。本附錄是第一、二層**唯一**的資料流程：不論是否開啟種子式散布都用它（未開啟時來源只有房主）。排程與預算見附錄 D，收看者之間的信令見[附錄 G](0007-appendix-g-swarm-signaling.md)。

## §1 與附錄 B、C 的對應

| 既有條文 | 狀態 |
| --- | --- |
| B §1 連線、`dataId`、ICE restart、版本 | 沿用；換 `pt-data` 改用 §2 的交接 |
| B §1 `config` | **重新定義**（§2）：全房共用，不再是「每條連線內」的編號 |
| B §1 `epoch` | **改為收看端的定位世代**（§2） |
| B §2 塊標頭與組裝 | **改用 §3** |
| B §3 時間軸、入口、驗收素材；B §5 sample entry；B §7 退路 | 沿用（影音分軌、各自的 append window 不變） |
| B §4 第 1～3、6 步，`hello`／`probe`／`probeResult`／`fail`／`ping`／`pong` | 沿用 |
| B §4 `config`、`state`、`status` 的欄位 | 依 §4 調整 |
| B §4 第 4～5 步（`position`→`ready`→房主推送、每次重送 init） | **改用 §2** |
| C §1 對時、畫面時間、應在時間 | 沿用 |
| C §1「片尾」、C §2 第 4a 列 `ended` | **改用 §2 的「片尾」** |
| C §2 播放狀態機 | 沿用；「本 `(config, epoch)`」指收看端目前的定位世代；「意圖改變」用 `state.seekId` 取代房主 epoch；`waitData`／`seek` 的「已緩衝」包含「片段已收齊驗證、可立即附加」 |
| C §3 入口公式與定位期限 | 沿用；期限從房主收到 `ready { config, epoch }` 起算；`r` 改用 §2 的估計 |
| C §4 背壓、quota、ManagedMediaSource、舊資料排空、停滯偵測 | **改用 §2**（配速條件 1、2 沿用） |
| C §5 房間預算 | 開啟散布時改用附錄 D §8 |

## §2 請求的生命週期

**`config`**：房主在本次直播工作階段內配發、**全房共用**的識別。同一 config 的每一份片段，對每位收看者都是完全相同的位元組；凡會改變位元組的因素不同，就是不同的 config：片源檔、層級、第二層的畫質與轉碼世代、`hev1`／`hvc1`、選用的音軌、T-138 修補與否、封裝器版本。房主重新連線（新的直播工作階段）時重新配發。

**`epoch`**：收看端的定位世代。收看端每次重新定位（加入、自己跳轉、依房主 `position`、quota、ManagedMediaSource 恢復時 E 不在緩衝內）加 1，並送 `ready { config, epoch }`。之後的 `req`、`status` 都帶這個 epoch；房主據此丟掉舊 epoch 的請求，並以收到 `ready` 的時刻起算 C §3 的定位期限。**每個 epoch 開始時，所有請求的計數歸零。**

**`seekId`**：房主每次自己跳轉加 1，放在 `state` 裡。收看端用它判斷「房主意圖改變」（C §2），不用來丟資料。

**開始**：`hello` → `probe` → `probeResult` → `config`（含 init 的大小與小塊雜湊、各連線的 `chunk`，§3）→ `segtable`（分頁）→ 收看端建好 MediaSource 與兩軌 SourceBuffer，送 `ready { config, epoch }`，之後自己送 `req`。房主送 `position { config, entry, rateHint }` 表示「請重新定位到 `entry`」（`stuck`、或房主重新選入口時）：收看端開新 epoch、取消全部請求，照 B §4 第 4 步清緩衝與重設 append window，再從 `entry` 那一段開始要。

**init segment**：每個 config、每一軌一份，用 `req`（`index = INIT`）要。收看端留在記憶體，每次 `abort()` 之後自己重新附加，不必再要。

**接收空間預留**（以**請求的小塊位元組**記帳）：送出 `req` 前，收看端預留這次要的小塊大小總和。所有來源合計「已預留＋已收到未附加」≤ 16 MiB，其中 **4 MiB 只給「本 epoch 最早還沒附加的那一段」**（其他段最多用 12 MiB），所以後段收齊等著依序附加時，缺的那一段一定還能補請。每個來源最多 2 個請求在途；急件需要空間時先取消預讀的請求。房主端另檢查：同一收看者向房主在途的請求 ≤ 16 MiB，超過算協定錯誤。

**取消與遲到的資料**：`cancel { reqId }`，來源丟掉佇列中的部分。收看端收到的每一則資料，只有「`reqId` 是本 epoch、這條頻道上**仍有效**的請求」才收；其他一律丟棄、不計入、不算違規。只有 `reqId` **大於**這條頻道上發出過的最大值（從沒發出過）才算違規。ICE 恢復後晚到的舊資料因此直接丟掉。

**逾時**（D §4 只引用這張表）：

| 情況 | 急件 | 預讀 |
| --- | --- | --- |
| 送出 `req` 後還沒收到第一則 | 1.5 秒 | 3 秒 |
| 收到過資料後停住（沒有新資料） | 1.5 秒 | 3 秒 |
| 來源回 `nack`（沒有這段、不再轉送、沒有有效指派） | 立即 | 立即 |

逾時或 `nack`：取消這個請求，急件直接向房主要，預讀送 `where` 請房主改派。「沒有請求在途」的頻道沒有資料是正常的（例如緩衝已滿），不算停滯。

**換 `pt-data`**（C §4 的排空逾時）：房主開新頻道，送 `dataSwitch { dataId }`；收看端等新頻道 `open` 後回 `dataReady { dataId }`，把舊頻道上仍有效的請求以新的 `reqId` 在新頻道重發；房主收到 `dataReady` 才關閉舊頻道。舊頻道之後到的資料依上一段丟棄。

**ICE restart**：識別碼不變，逾時的請求照上表重發；中斷超過 5 秒才恢復時，收看端開新 epoch。

**片尾**：`segtable` 最後一頁帶 `last: true`，最後一段的 `flags` 標示結尾。**本 epoch 從入口到最後一段的每一段、每一軌都已依序附加完成**，待附加佇列為空、所有 SourceBuffer 都不在 `updating`，才呼叫 `endOfStream()`；C §2 的 `ended` 分支等同一個條件成立後，跳到最後一個有效影格並暫停。C §1 其餘規則（不設 `duration`、影音共同有效區間）不變。

**quota**：照 C §4 清除並重試一次；仍失敗就把自己的 `LEAD_BYTES` 減半（下限 16 MiB）、開新 epoch 重新定位，並回報 `quota`。同一 config 第 3 次送 `fail`，房主讓他降層。

**ManagedMediaSource**：`endstreaming` 時取消所有預讀請求、停止發新請求；`startstreaming` 時若 E 仍在緩衝內，從緩衝末端繼續要，否則開新 epoch、依 C §3 選入口。

**C §3 的 `r`**：有請求在途時 = `min(過去 3 秒實際收到的速率, 指派給他的來源配額合計)`；沒有請求在途（緩衝已滿、零流量）時不用量測值，直接用配額合計；剛加入沒有量測時用房主給的 `rateHint`。

**片段必須可重現**：第一層的封裝器必須是確定的（不寫時間、亂數），T-141 以「同一段封裝兩次位元組相同」驗收。第二層的轉碼不保證可重現：房主保留已公布的轉碼片段 `[E − 30 秒, E + LEAD_S]`；需要重新產生已公布的段（快取已清、編碼器重設、往回跳出保留範圍）時，改開新的 config（新的轉碼世代），收看者在下一個入口段切換。

## §3 分框與小塊

- **片段與軌**：每個時段 `index` 有影像與音訊兩份片段（無聲片只有影像），各自封裝、各自公布大小與雜湊、各自附加到自己的 SourceBuffer（B §3 的 append window 不變）。
- **小塊**：每份片段每 256 KiB 一塊（最後一塊較短）。片段 ≤ 4 MiB，最多 16 塊。
- **每則訊息上限 `chunk`**：每條連線的兩端各自宣告 `min(64 KiB, 自己的 sctp.maxMessageSize)`（房主在 `config`、收看者在 `hello`；收看者之間在 `sw-ctl` 的 `hello`），送方用兩者較小值。
- **每則** = 20 bytes 標頭＋資料，整則 ≤ `chunk`。標頭（big-endian）：

  | 位移 | 長度 | 欄位 | 說明 |
  | --- | --- | --- | --- |
  | 0 | 1 | `kind` | 1 = init，2 = 片段，3 = 抽查回覆（附錄 D §5） |
  | 1 | 1 | `track` | 0 = 影像，1 = 音訊 |
  | 2 | 2 | `piece` | 塊序號 |
  | 4 | 4 | `config` | |
  | 8 | 4 | `index` | 時段序號（init 為 `0xFFFFFFFF`） |
  | 12 | 4 | `reqId` | 請求編號（抽查時為 `auditId`） |
  | 16 | 4 | `offset` | 塊內位移 |

- **合法的框**：同一條頻道一次只送一塊；第一則 `offset = 0`，之後每則 `offset` = 前一則 `offset` + 前一則長度；長度 > 0；`offset + 長度 ≤ 這一塊的大小`；`offset + 長度 = 塊大小` 即這塊結束。違反就是協定錯誤。
- **驗證與交付**：收齊一塊就比對雜湊；通過才標記為已有，並可**立刻**轉送給有效指派的請求者（邊收邊轉）。一份片段的每一塊都通過，才把它交給該軌的 SourceBuffer；同一 epoch 內每一軌依 `index` 順序附加，先收齊的後段等前段。
- **請求範圍**：`req` 帶 `track` 與 `pieces: [a, b)`，同一段可以由不同來源各送一部分。
- **片段表**：每段 `[start, end, flags]`，`flags` bit0 = 入口段（影像可獨立解碼），bit1 = 最後一段。

## §4 訊息

| 方向 | type | 內容 |
| --- | --- | --- |
| 房主 → 收看者（`pt-ctl`） | `config` | B §4 的欄位，另加 `chunk`、`init: [{ track, size, pieces }]` |
| | `segtable` | `{ config, page, segs: [[start, end, flags], …], last }` |
| | `seg` | `{ config, index, tracks: [{ track, size, pieces: [sha256, …] }], sources: [{ from: 'host' \| memberId, grantId?, track, pieces: [a, b) }, …] }`（公布＋指派；改派時再送） |
| | `grant` | `{ grantId, to, config, index, track, pieces: [a, b), expiresAt }`：給**來源端**的出站指派（附錄 D §4） |
| | `revoke` | `{ grantId }` |
| | `position` | `{ config, entry, rateHint }` |
| | `state` | B §4 的欄位，以 `seekId` 取代 `epoch` |
| | `dataSwitch` | `{ dataId }` |
| | `drop` | `{ peer }`：不要再向他拿 |
| | `audit` | `{ auditId, config, index, track, piece }`（附錄 D §5） |
| 收看者 → 房主（`pt-ctl`） | `ready` | `{ config, epoch }` |
| | `dataReady` | `{ dataId }` |
| | `have` | `{ config, ranges: [[a, b], …] }`，最多 16 段、每 500 ms（可替換）；回報的片段至少保留 5 秒 |
| | `req`／`cancel` | 同下（向房主要，不帶 `grantId`） |
| | `where` | `{ config, epoch, index, track }` |
| | `bad` | `{ peer, grantId, config, index, track, piece }` |
| | `status` | B §4 的欄位，計數改為本 epoch 的 `reservedBytes`、`receivedBytes`、`appendedBytes` |
| | `relay` | `{ on, upMbps, reason? }` |
| 收看者之間（`sw-ctl`） | `hello` | `{ chunk }` |
| | `req` | `{ reqId, grantId, config, epoch, index, track, pieces: [a, b) }` |
| | `cancel`／`nack` | `{ reqId }` |
| 資料（`pt-data`、`sw-data`） | — | 二進位，§3 |

- 來源只服務「帶有效 `grantId`、請求者與範圍都符合、未過期」的請求，其他回 `nack`。速率上限、單則大小、可替換訊息的規則同 B §4。
