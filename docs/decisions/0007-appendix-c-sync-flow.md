# ADR 0007 附錄 C：同步、流量控制與選層規則草稿（T-140）

> **草稿（T-140）**：ADR 0007 採用前沒有效力。第七版起資料改為片段表與收看端主動要，本附錄哪些條文沿用、哪些被取代見[附錄 F §1](0007-appendix-f-swarm-protocol.md)。單位：時鐘與期限一律**毫秒**，`performance.now()`、`performance.timeOrigin` 與 `requestVideoFrameCallback` 的 `expectedDisplayTime` 都以同一份文件的時間原點計；媒體時間一律**秒**（輸出時間軸，附錄 B §3）；位元率 **bit/s**；位元組 **byte**。識別碼 `(config, epoch, dataId)` 與握手見附錄 B §1、§4。

## §1 對時與畫面時間

**對時**（收看端主動）：

1. 收看端送 `ping { t0 }`，房主回 `pong { t0, t1 }`，收看端收到時記 `t2`。樣本 = `{ rtt: t2 − t0, offset: t1 − (t0 + t2) / 2, at: t2 }`；時鐘 = `performance.timeOrigin + performance.now()`。
2. 有效樣本：最近 60 秒內、最多 16 筆；估計值取 RTT 最小者（誤差上限 RTT／2）。
3. 頻道開啟、ICE restart 回到 `connected`、分頁回到前景時清空樣本，以 50 ms 間隔量 8 次；平時每 2 秒一次。沒有有效樣本時不追趕，只顯示「同步中」。

**畫面時間**（雙方同一算法）：

- 錨點 = 最近一次 `requestVideoFrameCallback` 的 `{ p: expectedDisplayTime, m: mediaTime }`。
- 「正在播放、不在 `seeking`／`waiting`、錨點距今 < 250 ms、錨點之後沒有 `pause`／`seeking`／`waiting`／`ratechange`／換來源」時，畫面時間 = `m + (performance.now() − p) / 1000 × playbackRate`；否則用 `currentTime`。上述事件發生時立即作廢錨點（`expectedDisplayTime` 是預估值，作廢規則避免在暫停或卡住時繼續外插）。

**房主 `state { config, epoch, playing, ended, mediaTime, hostClock, rate }`**：`playing` = 沒暫停、不在 `seeking`、`readyState ≥ 3`；`mediaTime` = 房主畫面時間；`hostClock` = 讀取當下的房主時鐘。`play`、`pause`、`playing`、`waiting`、`seeking`（送 `playing: false`）、`seeked`、`ratechange` 時送，另每秒一次。

**片尾**：`end` = 影音共同終點（`config.end`，附錄 B §4）。收看端不用自己看到的緩衝判斷片尾（分不出「已送完」與「還沒到」）。從位置 P 起「需要的緩衝」= `[P, min(P + 門檻, end))`，而且**位置 P 本身一定要有兩軌的資料**（只有影像或音訊已在該軌結尾時例外）。「已到片尾、不需要後續緩衝」的豁免，**只在本 `(config, epoch)` 已收到**本 config 實際建立的每一軌**（無聲片只有影像）的送完標記（附錄 B §2 `kind = 4`）且全部附加完成後**才適用；最後一段延遲到達時，收看端照常留在 `waitData`。`end` 只用於緩衝判定，**不設 `MediaSource.duration`**：收到每一軌的送完標記、待附加佇列都清空、所有 SourceBuffer 都不在 `updating` 之後，才呼叫 `endOfStream()`，片長由 MSE 依實際附加的資料決定（影音在容差內不等長時以較長軌為準）。房主自然播完以 `state.ended = true` 表示（狀態機的 `ended` 分支，§2）。

**應在時間** `E = playing ? mediaTime + (本機時鐘 + offset − hostClock) / 1000 × rate : mediaTime`。

## §2 收看端播放狀態機

**評估時機**：每 100 ms，以及收到 `state`、`seeked`、`updateend`、計時器到期時。`drift = 收看端畫面時間 − E`（秒，正值＝超前），`R` = 房主 `rate`。

**意圖改變**（`config`／`epoch` 改變、`playing` 由真變假或由假變真、`R` 改變）才作廢 **hold 計時器**。每秒的例行 `state` 內容沒變，不作廢任何工作。**已發出的瀏覽器跳轉不作廢**：它的 5 秒逾時照算，`seeked` 或逾時時依**最新**的房主狀態重新評估（`config`／`epoch` 已改變時，這次跳轉的結果不計入對齊判斷）。hold 計時器帶「意圖代號」，到期時代號已失效就什麼都不做；跳轉不帶意圖代號，只記下發出時的 `(config, epoch)`，`seeked` 或逾時一律重新評估。所有回呼都只觸發重新評估，不直接 `play()`。

依**優先順序**取第一個成立的狀態：

| 優先 | 狀態 | 條件 | 動作 |
| --- | --- | --- | --- |
| 1 | `notReady` | 本 `(config, epoch)` 尚未收到入口資料，或沒有有效對時 | 暫停，回報 `buffering` |
| 2 | `seekTimeout` | 自發跳轉 5 秒仍未 `seeked` | 放棄等待這次跳轉（之後晚到的 `seeked` 只觸發重新評估），記一次失敗；連續 2 次失敗回報 `stuck`（房主重新定位，§3），否則回到評估 |
| 3 | `seeking` | 自發跳轉尚未 `seeked`（未逾 5 秒） | 等待（房主暫停也一樣：進行中的跳轉先等完或逾時，再依房主狀態決定） |
| 4a | `ended` | `state.ended = true` | 等附錄 F §2「片尾」的條件成立（本 epoch 從入口到最後一段每一軌都已附加），然後跳到最後一個有效影格並暫停；不做落後重新定位 |
| 4 | `hostPaused` | `playing = false` | 暫停；`\|drift\| > 50 ms` 且 E 已緩衝時跳到 E；不排 hold |
| 5 | `waitData` | 從 E 起需要的緩衝（門檻 0.5 秒，見 §1「片尾」）未齊，影音取較短者 | 暫停，回報 `buffering` |
| 6 | `seek` | 落後 ≥ 300 ms 或超前 ≥ 3 秒；距上次跳轉 ≥ 1 秒 | 目標 `S = E + seekLead × R`；S 夾在 `end − 1 格` 以內；**S 本身有兩軌資料、且從 S 起需要的緩衝（門檻 0.5 秒）都已齊**才跳（片尾豁免的條件同 §1），否則留在 `waitData`。`seekLead` = 上次 `seeking→seeked` 耗時 + 50 ms，夾在 0～1 秒 |
| 7 | `hold` | 80 ms ≤ 超前 < 3 秒 | 暫停，排 `drift / R` 秒的計時器 |
| 8 | `play` | 其他 | 若暫停中就 `play()`（這是從 `hold`、`waitData`、`hostPaused` 恢復的唯一路徑）；`playbackRate = R × (1 − sign(drift) × min(0.05, 0.5 × \|drift\|))`，`\|drift\| ≤ 15 ms` 時 `= R` |

- `play()` 被自動播放政策拒絕：回到「點擊開始觀看」，不重試。
- 原型只做了這張表的一部分（沒有可取消的工作與逾時），附錄 A 的 1～6 秒是原型的結果。

**等所有人**（房主選項，T-143 之後）：

- 參與者：已按「開始觀看」、在線、第一或第二層的收看者。第三層與尚未開始的人不參與。
- 觸發：參與者 `buffering` 超過 2 秒，或房主跳轉。房主記下「暫停原因 = 等人」再暫停。
- 結束：全部參與者從 E 起需要的緩衝（門檻 1 秒）都已齊，或等滿 8 秒。只有暫停原因仍是「等人」才自動繼續；等待中房主手動暫停或播放、或再次跳轉，都覆蓋這次等待（跳轉則以新 epoch 重新等）。
- 8 秒逾時後，同一位收看者 60 秒內不能再觸發。
- 開啟時入口一律選 Kp（§3），因為房主暫停時到不了下一個入口。

## §3 入口選擇與重新定位

符號：`t` 房主目前媒體時間、`ρ` 房主播放速率（暫停時 0）、`b` 片源位元率、`r` 這位收看者此刻的追趕速率（§5）、`X = min(1, 片尾 − t)`、`Kp ≤ t` 前一個入口、`Kn > t` 下一個入口。模型：從入口 K 起送，經過 T 秒已送 `r·T / b` 秒的媒體；開播條件是已送量涵蓋「房主位置之後 X 秒」。

- **從 Kp**：需要 `r·T/b ≥ (t − Kp) + ρ·T + X`。`r > ρ·b` 時 `Tp = (t − Kp + X) · b / (r − ρ·b)`，否則 `Tp = ∞`。（`ρ = 0` 時為 `(t − Kp + X) · b / r`。）
- **從 Kn**：房主到達 Kn 需 `d = (Kn − t) / ρ`（`ρ = 0` 時 `d = ∞`、`Tn = ∞`）。
  1. 若 `r·d/b ≥ X`：到達 Kn 時已有 X 秒，`Tn = d`。
  2. 否則若 `r > ρ·b`：需要 `r·T/b ≥ ρ·(T − d) + X`，`Tn = (X − ρ·d) · b / (r − ρ·b)`（此值必 ≥ d）。
  3. 否則 `Tn = ∞`。
- 取較小者；片尾沒有 Kn 時只看 Kp；「等所有人」開啟時只用 Kp。
- 兩者皆 ∞ 或 > 10 秒：這位收看者降一層。開播期限見下方「定位中」。
- 範例：`Kn − t = 0.1`、`r = 1.1b`、`ρ = 1`、`X = 1` → 情況 2，`Tn = 0.9 / 0.1 = 9` 秒。`Kn − t = 1.5`、`r = 0.5b`、`ρ = 1` → `r·d/b = 0.75 < 1` 且 `r ≤ ρb` → `Tn = ∞`。`r = ρb`、`Kn − t = X` → 情況 1，`Tn = d`。

**開播期限與重新定位**分兩個階段，避免中途加入時被誤判落後：

- **定位中**：從房主收到本 epoch 的 `ready` 起，到「**對齊**」為止。對齊 = 收看端在本 epoch 附加資料之後，`requestVideoFrameCallback` 回報了一張 `mediaTime ≥ 入口` 的已呈現畫面，且當時 \|drift\| < 100 ms；只看 `currentTime` 不算（重新定位後收看端可能停在舊位置，`currentTime` 碰巧接近房主）。只用開播期限——收到 `ready` 後 10 秒，不計房主暫停的時間與收看端 `status.state = 'awaitingClick'`（停在「點擊開始觀看」）的時間。逾期就降一層。這段期間**不做**落後重新定位（例如房主 60 秒、收看端 0 秒、下一個入口要等 4 秒，是正常的）。
- **已對齊後**：收看端回報 `stuck`，或畫面時間落後 E 超過 3 秒且持續 2 秒（不計房主暫停時間），房主只對這位收看者開新 epoch，照上面重選入口（附錄 B §4 `position` 握手）。

## §4 雙邊背壓

收看端 `status` 回報三個**累計值**（在同一 `(config, epoch, dataId)` 內單調遞增）：`receivedBytes`（已收到的資料塊位元組，含組裝中）、`appendedBytes`（已成功附加進 SourceBuffer）、以及 `aheadBytes`、`aheadSeconds`（SourceBuffer 中 E 之後的量）與各 SourceBuffer 的 `buffered`（最多 4 段）。房主檢查：`receivedBytes ≥ appendedBytes`、兩者都 ≤ 本輪已送量；違反即協定錯誤（附錄 B §7）。

**房主送下一塊之前**，下列全部成立：

1. **配速**：`vt`（毫秒）不超前 `performance.now()` 15 ms 以上；每塊送出後 `vt += bytes × 8 / rate × 1000`；`vt` 最多落後現在 50 ms。
2. `bufferedAmount ≤ 1 MiB`（否則等 `bufferedamountlow`，門檻 256 KiB）。
3. **網路在途** = 已送 − `receivedBytes` ≤ 8 MiB。
4. **收看端待處理** = `receivedBytes` − `appendedBytes` ≤ 16 MiB。
5. **接收空間預留**：開始送一個片段前，`已送 − appendedBytes + 這個片段的大小 ≤ 16 MiB`（片段送到一半不再檢查）。這保證收看端的 16 MiB 硬上限不會被房主送超過。
6. **超前**：`aheadBytes` + 在途 + 待處理 ≤ `LEAD_BYTES`；下一塊的開始時間 ≤ `L + LEAD_S`，其中
   - 收看端在本 epoch **尚未開播**：`L = max(入口時間, E)`（中途加入、跳轉後的第一批資料以入口為準，不會被收看端舊位置卡住）；
   - 已開播：`L = min(E, 收看端畫面時間 + 3)`（收看端卡住時不會繼續往前灌）。
   - `LEAD_S = min(20, LEAD_BYTES × 8 / b)`，`LEAD_BYTES` 預設 80 MiB（40 Mbps 時約 16.8 秒）。
7. 收看端沒有回報 `streaming { on: false }`。

**片段大小**：所有片段封裝後 ≤ `min(4 MiB, 256 × (每則大小 − 16))`，影像片段另限 2 秒（續接片段可在任何 sample 邊界切開），沒有大 sample 例外（附錄 B §2）。條件 3 以塊為單位檢查、條件 5 以片段為單位預留，合法片段不會卡住。所有位元組計數（已送、`receivedBytes`、`appendedBytes`、預留）都以**封裝後的片段位元組**（不含 16 bytes 塊標頭）為準。

**收看端**：

- 組裝中與待附加的資料**共用 16 MiB 硬上限**；超過就是協定錯誤（房主依條件 5 預留，不應送超過）。
- 每 250 ms 回報 `status`；`pt-ctl` 的 `bufferedAmount` > 16 KiB 時不送新的，只保留最新一份，等降下來再送（可替換的狀態合併成一則）。
- 清已播緩衝：`min(currentTime, E) − 10 秒` 之前的範圍。
- `QuotaExceededError`：(1) 清掉 `min(currentTime, E) − 1 秒` 之前的資料，等 `updateend` 後重試一次；(2) 仍失敗就回報 `quota`，停止附加，等房主的 `position`。
- 房主收到 `quota`：把這位收看者的 `LEAD_BYTES` 減半（下限 16 MiB），**立即**以新 epoch 重新定位（§3）。新 epoch 讓收看端清掉該 config 的全部緩衝，空間一定會釋放，不會互等。同一 config 內第 3 次 `quota` 就降層。
- ManagedMediaSource：`endstreaming` 時回報 `streaming { on: false }`，房主停送；`startstreaming` 時回報 `on: true` 與實際 `buffered`，房主從 E 之後的緩衝末端續送；E 不在緩衝內就重新定位。

**跳轉時已排入 SCTP 的舊資料**：應用層配速不能保證 SCTP 何時排空。新 epoch 開始後 2 秒內 `bufferedAmount` 沒降到 256 KiB 以下，房主開一條新的 `pt-data`，以 `position { dataId }` 交接（附錄 B §1），舊頻道關閉。

**停滯偵測**：`bufferedAmount > 0` 且 3 秒沒有下降，或房主有資料待送而收看端 `receivedBytes` 3 秒沒前進：這位收看者的速率減半並記一次「卡住」（降層依據）。

## §5 房間預算分配

> 開啟種子式散布時改用附錄 D §8 的分配（房主只直送部分份數，其餘由收看者轉送）。不論是否開啟，經 TURN 的收看者都先扣掉預留 `R_T`（附錄 H）；本節與 §3、§4 中的第三層預留一律以 `R3 + R_T` 計。

- `預算 B = 房主選的上傳頻寬 × 0.7`，涵蓋**全部上傳**：DataChannel 與第三層的 RTP。
- 每位收看者的穩態預留（含 10% 協定開銷）：
  - 第一層：`1.1 × b`（b 是檔案平均位元率，已含音軌）；
  - 第二層：`1.1 × (轉碼影像位元率 + 原音軌位元率)`；
  - 第三層：`1.1 × (現行 P2P 的 maxBitrate + 128 kbps)`。
- **分配**（加入、離開、換片、改畫質時重算）：依加入順序，每位收看者的候選層 = `max(能力允許的最高層, 降層紀錄)`（降層紀錄在「重試原片」前不會被重算覆蓋）。依序放進候選層，若總預留超過 `0.8 B` 就改放下一層；第二層不可用（T-144 前）就直接第三層。第三層一定放得下名額，但總預留可能超過 B。
- **追趕餘額** `A = max(0, B − 總預留)`。正在追趕（尚未開播，或超前 < 5 秒）的收看者平分 A：`r = min(穩態預留 + A 份額, 6 × b)`；其他人 `rate = min(1.5 × b, 穩態預留 + A 份額)`。`A = 0` 時追趕速率就是穩態預留，§3 的估計可能為 ∞，該收看者會降層。`MIN_PACE`（8 Mbps）只在不超過 `穩態預留 + A 份額` 時套用。
- 第三層的總量照現行 P2P 規則（超過提醒線時提示，不強制）；第三層的 WebRTC 頻寬估計自行調整，不由這裡配速。
- 範例：上傳 110 → `B = 77`、`0.8 B = 61.6`。4K 40 Mbps（含音軌）× 3 人，第二層 1080P 8 Mbps＋原音軌 0.19 Mbps：
  - 第一位第一層 `1.1 × 40 = 44`；
  - 第二位放第一層會到 88 > 61.6 → 第二層 `1.1 × 8.19 ≈ 9.0`，合計 53.0；
  - 第三位放第二層會到 62.0 > 61.6 → 第三層 `1.1 × 8.128 ≈ 8.9`，合計 61.9；
  - `A = 77 − 61.9 = 15.1`。滿房（7 位收看者）時再加 4 位第三層，總預留 `61.9 + 4 × 8.94 ≈ 97.7 > 77`，`A = 0`；第三層照現行 P2P 軟限制，只提示不擋。
- **停送 RTP**：第一、二層的收看者，房主 transport 對該 peer 設「媒體暫停」旗標並 `replaceTrack(null)`；**所有**會更新 track 的路徑（換片、播完重播的 `addtrack`、`setQuality`、重新協商）都要先看這個旗標（現行 `transport/p2p/host-peer.ts` 的 track 更新需配合，T-141 契約）。改回第三層時清旗標並 `replaceTrack(當下的 track)`，不重新協商。

## §6 常數

| 名稱 | 值 |
| --- | --- |
| 追趕週期 | 100 ms |
| 不調整／暫停等待／落後跳轉／超前跳轉 | 15 ms／80 ms／300 ms／3 s |
| 速率調整上限、增益 | ±5%、0.5 |
| 跳轉間隔、跳轉提前量上限、跳轉逾時 | 1 s、1 s、5 s |
| `X`、開播與跳轉所需緩衝 | `min(1 s, end − t)`、門檻 0.5 s（依 §1「片尾」截到 `end`） |
| 入口估計上限、開播期限（不計暫停與等點擊） | 10 s、10 s |
| 重新定位（只在本 epoch 已對齊後） | `stuck`，或落後 > 3 s 持續 2 s |
| `bufferedAmount` 高／低水位、`pt-ctl` 上限 | 1 MiB／256 KiB、16 KiB |
| 網路在途、收看端待處理（硬上限，送片段前預留） | 8 MiB、16 MiB |
| 片段上限（封裝後位元組，無例外） | `min(4 MiB, 256 × (每則大小 − 16))`；影像片段另限 2 s |
| `LEAD_BYTES`、`LEAD_S` | 80 MiB（quota 後減半，下限 16 MiB）、`min(20, LEAD_BYTES × 8 / b)` |
| 已播保留 | 10 s |
| 配速倍數（平常／追趕）、追趕門檻 | 1.5／6、尚未開播或超前 < 5 s |
| 停滯判定、舊資料排空期限 | 3 s、2 s |
| 等所有人：觸發、上限、冷卻 | 緩衝 > 2 s、8 s、60 s |
