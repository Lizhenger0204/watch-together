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
| C §3 入口公式與定位期限 | 沿用；入口由房主在 `position` 告知，期限從房主送出 `position` 起算；`r` 改用 §2 的估計 |
| C §4 背壓、quota、ManagedMediaSource、舊資料排空、停滯偵測 | **改用 §2**（配速條件 1、2 與條件 6 的超前限制沿用） |
| C §5 房間預算 | 開啟散布時改用附錄 D §8 |

## §2 請求的生命週期

**`config`**：房主在本次直播工作階段內配發、**全房共用**的識別。同一 config 的每一份片段，對每位收看者都是完全相同的位元組；凡會改變位元組的因素不同，就是不同的 config：片源檔、層級、第二層的畫質與轉碼世代、`hev1`／`hvc1`、選用的音軌、T-138 修補與否、封裝器版本。房主重新連線（新的直播工作階段）時重新配發。

**`epoch`**：收看端的定位世代。**定位一律走同一個流程**：收看端開新 epoch（加入、自己跳轉到已附加與已請求範圍之外、quota、ManagedMediaSource 恢復時 E 不在緩衝內，或收到房主的 `reposition`）→ 取消舊 epoch 的全部請求、釋放預留、照 B §4 第 4 步清緩衝與重設 append window → 送 `ready { config, epoch }` → 房主依 C §3 選入口，回 `position { config, epoch, entry, rateHint }` → 收看端從 `entry` 那一段開始要。雙方的入口因此一致；房主從送出 `position` 起算 C §3 的定位期限，並從那一刻開始為這個 epoch 發公告與指派。之後的 `req`、`status` 都帶 epoch，房主丟掉舊 epoch 的請求。**每個 epoch 的位元組計數（`reservedBytes`、`receivedBytes`、`appendedBytes`）歸零**；`reqId` 不歸零（見下）。

**`reqId`**：收看端配發，**在同一條 `RTCPeerConnection`（同一條 `pt-ctl` 或 `sw-ctl`）內跨 epoch、跨資料頻道遞增，不重複**；換 `pt-data` 也不重來，所以控制訊息裡的 `reqId` 不需要再帶 `dataId`。`ready` 送出後 2 秒沒收到對應的 `position` 就重送，連續 3 次都沒有就照 B §7 改第三層。

**`seekId`**：房主每次自己跳轉加 1，放在 `state` 裡。收看端用它判斷「房主意圖改變」（C §2），不用來丟資料。

**開始**：`hello` → `probe` → `probeResult` → `config`（含 init 的大小與小塊雜湊、各連線的 `chunk`，§3）→ `segtable`（分頁）→ 收看端建好 MediaSource 與兩軌 SourceBuffer → 照上一段開第一個 epoch。

**init segment**：每個 config、每一軌一份，用 `req`（`index = INIT`）要。收看端留在記憶體，每次 `abort()` 之後自己重新附加，不必再要。

**接收空間預留**（以**請求的小塊位元組**記帳）：送出 `req` 前，收看端預留這次要的小塊大小總和。所有來源合計「已預留＋已收到未附加」≤ 16 MiB。其中**保留區**＝尚未附加的 INIT（每軌）＋**每一軌**本 epoch 最早還沒附加的那一段，大小依公布值計算；保留區的請求永遠可以送，其他請求只能用 `16 MiB − 保留區`。INIT 每軌 ≤ 1 MiB（超過就停用該片源的第一、二層），所以保留區最多 `2 × (1 + 4)` MiB。所以後段收齊等著依序附加時，各軌缺的那一段一定還能補請。每個來源最多 2 個請求在途；急件需要空間時先取消預讀的請求。房主端另檢查：同一收看者向房主在途的請求 ≤ 16 MiB，超過算協定錯誤。

**超前限制**（取代 C §4 條件 6 的房主端判斷，數值不變）：收看端只要「開始時間 ≤ `L + LEAD_S`」的段，而且「SourceBuffer 中 E 之後的位元組＋已預留＋已收到未附加 ≤ `LEAD_BYTES`」。**保留區的請求不受這兩道超前限制**（例如影像超前量已滿、音訊缺段時仍可補請），所以不會因為某一軌佔滿預算而停住；`L` 照 C §4（本 epoch 開播前 `max(入口, E)`，開播後 `min(E, 畫面時間 + 3)`）。

**取消與遲到的資料**：`cancel { reqId }`，來源丟掉佇列中的部分。收看端收到的每一則資料，只有「`reqId` 是本 epoch、這條頻道上**仍有效**的請求」才收；其他一律丟棄、不計入、不算違規。只有 `reqId` **大於**這條頻道上發出過的最大值（從沒發出過）才算違規。ICE 恢復後晚到的舊資料因此直接丟掉。來源（包括房主）收到 `cancel` 後在**下一個小塊邊界**停止。

**逾時**（D §4 只引用這張表）：

| 情況 | 急件 | 預讀 |
| --- | --- | --- |
| 送出 `req` 後還沒收到第一則 | 1.5 秒 | 3 秒 |
| 收到過資料後停住（沒有新資料） | 1.5 秒 | 3 秒 |
| 來源回 `nack`（沒有這段、不再轉送、沒有有效指派） | 立即 | 立即 |

逾時或 `nack`：取消這個請求，急件直接向房主要，預讀送 `where { …, grantId, reason }` 請房主改派。「沒有請求在途」的頻道沒有資料是正常的（例如緩衝已滿），不算停滯。**房主自己當來源時**，同一位收看者 60 秒內逾時 2 次，就照 C §4 的停滯偵測把他的速率減半並記一次「卡住」（D8 的降層依據）。

**換 `pt-data`**：房主送出新的 `position` 後 2 秒內，這位收看者的 `pt-data` `bufferedAmount` 沒降到 256 KiB 以下（舊 epoch 的資料還塞在 SCTP 裡），房主開新頻道並送 `dataSwitch { dataId }`。收看端收到 `dataSwitch` 時，**立刻**把舊頻道上的請求全部視為取消、釋放預留；新頻道 `open` 後回 `dataReady { dataId }`，再以新的 `reqId` 在新頻道重發仍需要的請求。房主收到 `dataReady` 才關閉舊頻道。5 秒內沒收到 `dataReady`：照 B §7 的協定錯誤處理（這位收看者改第三層）。

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
- **插隊點**：送方在每個小塊結束後重新挑下一塊（依片段開始時間，急件優先），不在小塊中間插入別的資料。
- **驗證與交付**：收齊一塊就比對雜湊；通過才標記為已有，並可**立刻**轉送給有效指派的請求者（邊收邊轉）。一份片段的每一塊都通過，才把它交給該軌的 SourceBuffer；同一 epoch 內每一軌依 `index` 順序附加，先收齊的後段等前段。
- **請求範圍**：`req` 帶 `track` 與 `pieces: [a, b)`，同一段可以由不同來源各送一部分。
- **片段表**：每段 `[start, end, flags]`，`flags` bit0 = 入口段（影像可獨立解碼），bit1 = 最後一段。

## §4 訊息

| 方向 | type | 內容 |
| --- | --- | --- |
| 房主 → 收看者（`pt-ctl`） | `config` | B §4 的欄位，另加 `chunk`、`init: [{ track, size, pieces }]` |
| | `segtable` | `{ config, page, segs: [[start, end, flags], …], last }` |
| | `seg` | `{ config, index, tracks: [{ track, size, pieces: [sha256, …] }], sources: [{ from: 'host' \| memberId, grantId?, expiresAt?, track, pieces: [a, b) }, …] }`（公布＋指派；改派時再送） |
| | `grant` | `{ grantId, to, config, index, track, pieces: [a, b), expiresAt }`：給**來源端**的出站指派（附錄 D §4） |
| | `nack` | `{ reqId }`：房主當來源時拒絕請求（例如 config 已換） |
| | `reposition` | `{ config }`：請收看端開新 epoch（`stuck` 或房主重選入口） |
| | `revoke` | `{ grantId }` |
| | `position` | `{ config, epoch, entry, rateHint }`：回應 `ready` |
| | `state` | B §4 的欄位，以 `seekId` 取代 `epoch` |
| | `dataSwitch` | `{ dataId }` |
| | `drop` | `{ peer }`：不要再向他拿 |
| | `audit` | `{ auditId, config, index, track, piece }`（附錄 D §5） |
| 收看者 → 房主（`pt-ctl`） | `ready` | `{ config, epoch }` |
| | `dataReady` | `{ dataId }` |
| | `granted` | `{ grantId }`：來源端已收下指派（附錄 D §4） |
| | `peerOpen`／`peerClosed` | `{ peer, pairId }`：與這位鄰居的 `sw-ctl`、`sw-data` 都已開／已關（附錄 G §3） |
| | `have` | `{ config, ranges: [[a, b], …] }`，最多 16 段、每 500 ms（可替換）；回報的片段至少保留 10 秒 |
| | `req`／`cancel` | 同下；向房主要時**合法地不帶** `grantId`（房主永遠可服務自己有效 config 的請求） |
| | `where` | `{ config, epoch, index, track, grantId?, reason: 'timeout' \| 'nack' \| 'closed' }` |
| | `bad` | `{ peer, grantId, config, index, track, piece }` |
| | `auditNack` | `{ auditId }`：沒有那一塊（附錄 D §5 視為「無資料」） |
| | `status` | B §4 的欄位，計數改為本 epoch 的 `reservedBytes`、`receivedBytes`、`appendedBytes`；當來源時另帶 `grants: [{ grantId, pendingBytes, sentBytes }]`（`pendingBytes` = 已收到請求、還沒送出的位元組；附錄 D §4「卡住」的證據） |
| | `relay` | `{ on, upMbps, reason? }` |
| 收看者之間（`sw-ctl`） | `hello` | `{ chunk }` |
| | `req` | `{ reqId, grantId, config, epoch, index, track, pieces: [a, b) }` |
| | `cancel`／`nack` | `{ reqId }` |
| 資料 | — | 二進位，§3。`pt-data` 房主 → 收看者送 `kind` 1、2；收看者 → 房主**只允許** `kind = 3`（抽查回覆），且只在有效的 `audit` 期間（5 秒內、一塊）；`sw-data` 雙向送 `kind` 1、2 |

- 來源只服務「帶有效 `grantId`、請求者與範圍都符合、未過期」的請求，其他回 `nack`。速率上限、單則大小、可替換訊息的規則同 B §4。
