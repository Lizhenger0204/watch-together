# ADR 0007 附錄 B：規格草稿（T-140）

> **草稿（T-140）**：本附錄在 ADR 0007 採用前沒有效力，現行 `streaming.md`、`protocol.md` 不變。採用後由 T-141～T-144 依序搬進正式規格，搬的時候先改規格與 `packages/shared`，再改實作。

## §1 頻道與版本

- 只在 **P2P 模式**使用。房主為每位收看者建立的 `RTCPeerConnection` 上，**由房主**在第一次 offer 前開兩條 DataChannel（之後 ICE restart 沿用，不重開）：

  | label | 設定 | 內容 |
  | --- | --- | --- |
  | `pt-ctl` | `ordered: true`，可靠 | JSON 文字訊息（§3） |
  | `pt-data` | `ordered: true`，可靠，`binaryType = 'arraybuffer'` | 二進位分塊（§2） |

- 開頻道的時機由 `transport/p2p/` 提供掛勾（GPT 目錄），`features/passthrough/` 只拿到兩個已開啟的 `RTCDataChannel`。
- 版本：`PASSTHROUGH_VERSION = 1`，放在收看端第一則 `pt-ctl` 訊息 `hello`。房主不支援該版本時回 `tier { tier: 'live', reason: 'version' }`，該收看者走第三層。
- DataChannel 開不起來（例如對端瀏覽器拒絕 SCTP）：該收看者走第三層，不影響媒體軌。

## §2 二進位分塊（`pt-data`）

每則訊息 = 16 bytes 標頭＋資料，整則不超過 `min(64 KiB, pc.sctp.maxMessageSize)`。欄位皆為 big-endian：

| 位移 | 長度 | 欄位 | 說明 |
| --- | --- | --- | --- |
| 0 | 1 | `kind` | 1 = init segment，2 = 媒體片段 |
| 1 | 1 | `track` | 0 = 影像，1 = 音訊 |
| 2 | 1 | `last` | 1 = 這個片段的最後一塊 |
| 3 | 1 | 保留 | 0 |
| 4 | 4 | `epoch` | 房主送出這塊時的 epoch |
| 8 | 4 | `seq` | 片段序號，同一條連線內遞增（init 為 0） |
| 12 | 2 | `index` | 塊序號，從 0 起 |
| 14 | 2 | `count` | 這個片段共幾塊 |

- 可靠有序，所以收看端只要依序串接；遇到 `(kind, track, epoch, seq)` 改變或 `index = 0` 就丟掉沒收完的部分（房主跳轉時會中途放棄片段）。
- **init segment 一律接受與保留**，不受 epoch 篩選（原型的 bug：清佇列時連 init 一起清掉）。
- 媒體片段 `epoch` 小於收看端目前的 epoch 就丟棄；大於就先切換 epoch（`pt-data` 可能比 `pt-ctl` 的 `state` 先到）。

**片段內容**（ADR D5）：每條軌一個 SourceBuffer。init = `ftyp`＋`moov`（`mvex/trex`）；媒體 = `moof`（`mfhd`、`tfhd` default-base-is-moof、`tfdt` v1 絕對解碼時間、`trun` v1 含 duration／size／flags／有號 composition offset）＋`mdat`。影像 timescale 90000，音訊 timescale = 取樣率。影像片段以關鍵影格開頭，最長 2 秒；音訊片段 1 秒。

## §3 `pt-ctl` 訊息（JSON）

收看端 → 房主：

| type | 內容 | 時機 |
| --- | --- | --- |
| `hello` | `{ version, caps }` | 頻道開啟後第一則 |
| `ping` | `{ t0 }` | 開啟後每 50 ms 一次共 8 次，之後每 2 秒 |
| `probeResult` | `{ video: boolean, audio: boolean }` | 收到 `probe` 後 |
| `ready` | `{}` | 兩個 SourceBuffer 都建立好、可以收資料 |
| `status` | `{ epoch, presentedTime, aheadAtTarget, bufferedBytes, state, quotaHits }` | 每 250 ms |
| `quota` | `{ epoch }` | 遇到 `QuotaExceededError` |
| `streaming` | `{ on: boolean }` | ManagedMediaSource 的 `startstreaming`／`endstreaming` |
| `retry` | `{}` | 收看者按「重試原片」 |

房主 → 收看端：

| type | 內容 | 時機 |
| --- | --- | --- |
| `pong` | `{ t0, t1 }` | 收到 `ping` |
| `probe` | `{ video, audio }`（片源 MIME，含 codecs） | 收到 `hello` 後、換片時 |
| `tier` | `{ tier: 'passthrough' \| 'transcode' \| 'live', reason?, video?, audio? }` | 決定或改變層級時；`video`／`audio` 是 SourceBuffer 用的 MIME（含 codecs），`live` 時收看端停用 MSE、改用 `srcObject` |
| `state` | `{ epoch, playing, mediaTime, hostClock, rate }` | 播放狀態改變時立刻送，另外每秒一次 |

```ts
type PassthroughCaps = {
  mse: 'mse' | 'managed' | 'none'; // MediaSource／ManagedMediaSource／都沒有
  h264: boolean; // isTypeSupported('video/mp4; codecs="avc1.640028"')，第二層用
  platform: string; // navigator.userAgentData?.platform ?? navigator.platform
};
```

能力查詢的順序：收看端 `hello` 帶 `caps`。房主收到後送 `probe { video, audio }`（片源的 MIME，含 codecs），收看端以 `isTypeSupported` 回 `probeResult { video: boolean, audio: boolean }`，房主再依 ADR D8 送 `tier`。換片時重新 `probe`。

- `presentedTime`：最近一張已顯示畫面的 `mediaTime` 往後推（ADR D2）；`aheadAtTarget`：在「應在時間」位置往後的緩衝秒數（影音取小）。
- `state.mediaTime` 同樣是房主「畫面上」的時間。`hostClock` = `performance.timeOrigin + performance.now()`。
- `epoch`：房主每次跳轉、換片 +1。換片另外送新的 `tier`（MIME 可能變），收看端重建 MediaSource。

## §4 常數（`features/passthrough/` 內，非協定）

| 名稱 | 值 | 用途 |
| --- | --- | --- |
| `CHUNK_BYTES` | 64 KiB（取 `min` 於 `maxMessageSize`） | 分塊 |
| `DC_HIGH_WATER` / `DC_LOW_WATER` | 1 MiB / 256 KiB | `bufferedAmount` 保險 |
| `DC_STALL_MS` | 3,000 | `bufferedAmount` 不降即判定停滯 |
| `PACE_STEADY` / `PACE_CATCHUP` | 1.5 / 6 倍片源位元率 | 配速；超前不到 `CATCHUP_LEAD_S`（5 秒）用追趕倍數 |
| `MIN_PACE_BPS` | 8 Mbps | 低位元率片源的最低速率 |
| `UPLOAD_BUDGET` | 房主選的上傳頻寬 × 0.7 | 總預算，平分給收看者 |
| `LEAD_S` / `LEAD_BYTES` | 20 秒 / 80 MiB | 超前量取兩者較小 |
| `BACK_BUFFER_S` | 10 | 收看端保留已播秒數 |
| `START_BUFFER_S` | 1 | ADR D3 的 X |
| `VIDEO_FRAGMENT_MAX_S` / `AUDIO_FRAGMENT_S` | 2 / 1 | 片段長度 |
| `SYNC_TICK_MS` | 100 | 追趕檢查週期 |
| `DRIFT_DEAD_MS` | 15 | 不調整 |
| `DRIFT_HOLD_AHEAD_MS` | 80 | 超前即暫停等待 |
| `DRIFT_SEEK_BEHIND_MS` / `DRIFT_SEEK_AHEAD_MS` | 300 / 3,000 | 直接跳轉 |
| `RATE_MAX_ADJUST` / `RATE_GAIN` | 0.05 / 0.5 | 調速 |
| `SEEK_LEAD_MAX_MS` / `SEEK_MIN_INTERVAL_MS` | 1,000 / 1,000 | 跳轉提前量上限、兩次跳轉間隔 |
| `TRANSCODE_PROBE_S` / `TRANSCODE_MIN_SPEED` / `TRANSCODE_DOWNGRADE_SPEED` | 3 / 1.2 / 1.1 | 第二層試速與降層 |
| `TRANSCODE_KEYFRAME_S` | 2 | 第二層強制關鍵影格 |
| `TIER_STALL_LIMIT` | 60 秒內 2 次 | 降層 |
| `TIER_RETRY_MIN_INTERVAL_S` | 300 | 「重試原片」間隔 |

## §5 房主上傳頻寬（P2P，Mbps，穩態 1.0～1.5 倍）

| 片源 | 1 人 | 3 人 | 7 人 |
| --- | --- | --- | --- |
| 1080P 8 Mbps | 8～12 | 24～36 | 56～84 |
| 4K 25 Mbps | 25～38 | 75～113 | 175～263 |
| 4K 40 Mbps | 40～60 | 120～180 | 280～420 |

加入、跳轉時的追趕另外最多到預算上限。超過預算時，ADR D8 把位元率最高的收看者改成第二層。

## §6 `protocol.md` 草稿變動

- `MemberStatus` 加兩個選填欄位（`memberStatusSchema` 是 `z.object`，舊版會略過未知欄位，**不升版**）：

  ```ts
  type MemberStatus = {
    state: 'waiting' | 'connecting' | 'playing' | 'buffering' | 'failed';
    bitrateKbps?: number;
    rttMs?: number;
    packetLoss?: number;
    tier?: 'passthrough' | 'transcode' | 'live'; // 草稿（T-140）
    driftMs?: number; // 草稿（T-140）：收看端與房主畫面的差，正值＝收看端超前
  };
  ```

- 版本紀錄：若之後在 `RoomInfo`（strict）加入「傳送方式」等房間層設定，才升 `PROTOCOL_VERSION = 3`。
- REST、WebSocket 訊息類型都不變；伺服器不需要改程式（`member:status` 照舊只轉給房主）。

## §7 `streaming.md` 草稿變動

1. **新增 §10「原片直送」**（T-142 搬入）：ADR D2～D6 的規則與本附錄 §1～§4。
2. **§2 畫質**：畫質選「原片」或不低於片源時，第一層直接送原片；低於片源時走第二層（WebCodecs 轉碼），第三層才用 `scaleResolutionDownBy`。畫質面板新增「上傳頻寬」選項（ADR D4）。
3. **§3 P2P**：房主在第一次 offer 前開 §1 的兩條 DataChannel；ICE restart 與重新協商不重開。
4. **§6 模式切換**：切到轉發時所有收看者改第三層；切回 P2P 時依 ADR D8 重新選層。
5. **§7 收看端播放**：`tier` 為 `passthrough`／`transcode` 時 `<video>` 用 MediaSource（iOS 用 ManagedMediaSource，並設 `disableRemotePlayback = true`），`live` 時照舊 `srcObject`。同一個 `<video>` 切換來源前要先清掉另一種來源。「點擊開始觀看」規則不變。
6. **§8 統計**：收看端 `member:status` 帶 `tier` 與 `driftMs`；第一、二層的 `bitrateKbps` 取 `pt-data` 的收到速率。
7. **§9 傳輸層契約**：`HostTransport` 增加 `dataChannels(memberId)` 掛勾或在 `createHostTransport` 選項中傳入 `onPeerReady(memberId, { ctl, data })`。具體介面在 T-142 開工前由 Claude 與 GPT 協調定案。
