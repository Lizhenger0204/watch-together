# 規範：通訊協定

> 本檔是契約。實作位於 `packages/shared`（zod schema + 型別 + 常數）。
> 修改流程：先改本檔 → 改 `packages/shared` → 改前後端。破壞性變更要提高 `PROTOCOL_VERSION`。

## 通用

- 時間：epoch 毫秒（number）。
- `packages/shared` 另外提供：`normalizeInviteCode` / `formatInviteCode`（前後端共用的邀請碼正規化）、`QUALITY_PRESETS`（streaming.md §2 的畫質表）、`parseClientMessage` / `parseServerMessage`（解析 WebSocket 訊息）。前後端不可自己再寫一份。
- REST 錯誤格式：`{ error: { code: ErrorCode, message: string } }`。`message` 給人看，程式判斷只看 `code`。
- `ErrorCode`：`BAD_REQUEST`、`UNAUTHORIZED`、`FORBIDDEN`、`ROOM_NOT_FOUND`、`ROOM_FULL`、`RATE_LIMITED`、`STREAM_NOT_LIVE`、`RELAY_UNAVAILABLE`、`INTERNAL`。

## REST（apps/signal）

| 方法 | 路徑 | 認證 | 請求 | 回應 |
| --- | --- | --- | --- | --- |
| POST | `/api/rooms` | 無 | `{ nickname }` | `201 { roomId, inviteCode, hostToken, memberId }` |
| POST | `/api/rooms/join` | 新加入免認證；沿用身份帶 Bearer | `{ inviteCode, nickname, existingRoomId?, excludeRoomIds? }` | 新加入 `200 { roomId, memberToken, memberId }`；沿用 `200 { roomId, memberId, reused: true }` |
| POST | `/api/rooms/:roomId/invite-code` | host | — | `200 { inviteCode }`（重新產生） |
| GET | `/api/rooms/:roomId/ice` | 任一成員 | — | `200 { iceServers: RTCIceServer[] }` |
| POST | `/api/rooms/:roomId/whip` | host | SDP offer（`application/sdp`） | `201` SDP answer + `Location`；P2P 模式回 `409 STREAM_NOT_LIVE` |
| POST | `/api/rooms/:roomId/whep` | member | SDP offer | `201` SDP answer + `Location`；P2P 模式、未開播或無有效發布回 `409 STREAM_NOT_LIVE` |
| DELETE | `<Location>` | 同建立者 | — | `200` |
| GET | `/api/health` | 無 | — | `200 { ok: true, protocolVersion }` |

WHIP 只需房間已切到 relay 即可發布。P2P 模式下，WHIP 的 409 訊息為「請先切換到轉發模式再發布」，WHEP 的 409 訊息為「目前沒有可收看的轉發直播」。兩者皆用通用 REST 錯誤格式。若 SFU 建連期間已切離轉發、建立者離線，或 WHEP 所訂閱的發布已失效，即使房間又切回轉發或成員已重連，也會撤回這次登記並回 `409 STREAM_NOT_LIVE`（「房間狀態已變更，請確認轉發狀態後重試」）。踢人或淘汰成員後，舊憑證再送 WHEP 回 `401 UNAUTHORIZED`。若移除前就已驗證、移除後才登記，則回 `403 FORBIDDEN` 並回滾已建立的 tracks。

加入與沿用共用每 IP 每分鐘 10 次的限流。呼叫端可用 `excludeRoomIds` 列出已持有憑證的房間，禁止為這些房間配置新席位。帶 `existingRoomId` 時必須用 `Authorization: Bearer <token>`，且只嘗試沿用：邀請目錄與房間當下的碼皆符合、房號相同且憑證仍屬於成員，才回傳原 memberId 與 `reused: true`。客戶端保留原憑證與角色，沿用回應不含 token。鎖房與滿房不影響沿用。錯碼、錯房、沿用時的失效憑證及鎖房一律回相同的 `404 ROOM_NOT_FOUND`。只提供 header 或只提供房號也一律拒絕。新加入時，房間開放但已滿，一律回相同的 `409 ROOM_FULL` 本文。有空位才檢查排除名單，命中回 `404 ROOM_NOT_FOUND`。客戶端收到 404 或 409 都可嘗試沿用。

加入請求中的 `existingRoomId` 與 `excludeRoomIds` 接受大小寫 UUID，shared schema 驗證後一律轉成小寫再比對。

每次加入最多可列 16 個 `excludeRoomIds`。16 個 UUID 的緊湊 JSON 陣列為 625 位元組，足以在單次請求保護多房身份。整份加入請求的 UTF-8 本文上限為 2,048 位元組，保留暱稱、邀請碼、其他欄位與排版空間。恰好達到任一上限可接受。房號過多或實際本文超限都回 `400 BAD_REQUEST` 及通用錯誤本文。伺服器在解析 JSON 前計算串流位元組，超限即停止讀取。

## WebSocket

- 路徑：`/api/rooms/:roomId/ws`。
- 房間不存在、已關閉、正在關房，或 `roomId` 格式錯誤時，伺服器仍接受 upgrade，接著立刻以 `4001`（reason `room_closed`）關閉，不送任何訊息。四種情況的回應完全相同，不透露房間是否曾經存在。不直接回 HTTP 錯誤，是因為瀏覽器的 WebSocket 只看得到 `1006`，前端會一直退避重連。不是 upgrade 的請求仍回 `426`。
- 每則訊息為 JSON：`{ type: string, ...payload }`，用 `packages/shared` 的 discriminated union schema 解析。已驗證的連線解析失敗：回 `error` 並忽略該訊息；**未驗證的連線解析失敗：直接以 `4400` 關閉**。
- 第一則訊息必須是 `auth`，否則以 `4400` 斷線（見 room-and-invite.md）。5 秒期限以伺服器算完 token 雜湊的時間判斷。
- 需要回應的請求帶 `reqId`，伺服器回 `ack { reqId, ok: true } | { reqId, ok: false, code }`。
- 心跳：客戶端每 20 秒送 `ping`，伺服器回 `pong`。
- 同一成員只保留一條連線：新連線驗證成功後，舊連線以 `4000` 關閉。

### 房主重新連線（重新整理、另一分頁取代 `4000`、斷線重連）

房主每次驗證成功，都視為新的直播工作階段，伺服器依序：

1. 若原本在直播，改為未開播，對其他在線成員送 `stream:status { live: false, title: null, startedAt: null }`（收看者關閉舊的 P2P 連線或 WHEP）。
2. 回房主 `room:snapshot`，其中 `stream.live` 為 `false`。
3. 房主端若仍有可播放的片源，再送 `stream:status { live: true, title }`。
4. 伺服器廣播 `stream:status`，P2P 模式下對每位在線收看者送一則 `peer:request` 給房主。

房主端不能假設重連後還是開播狀態，也不需要自己記住要連哪些收看者；以伺服器送來的 `peer:request` 為準。

### 關閉碼

| code | 意義 | 客戶端該做什麼 |
| --- | --- | --- |
| `4000` | 被同一成員的新連線取代 | 不要自動重連（另一個分頁接手了） |
| `4001` | 房間已關閉；連線時房間已不存在（含到期、關房中、`roomId` 格式錯誤）也回 `4001` | 回首頁，不要重連 |
| `4003` | 被踢出 | 清除 token，回首頁 |
| `4400` | 格式錯誤或未驗證就送訊息、協定版本不符 | 重新整理頁面 |
| `4401` | token 無效 | 清除 token，回首頁 |
| `4408` | 5 秒內未完成驗證 | 重連 |
| 其他 | 網路中斷等 | 指數退避重連，重連後重新 `auth` |

### 客戶端 → 伺服器

| type | payload | 誰可以送 |
| --- | --- | --- |
| `auth` | `{ token, protocolVersion }` | 任何人（第一則） |
| `room:update` | `{ locked?: boolean, mode?: 'p2p' \| 'relay', quality?: Quality }` | host |
| `room:kick` | `{ memberId }` | host |
| `stream:status` | `{ live: boolean, title: string \| null }` | host |
| `signal` | `{ to: memberId, data: SignalData }` | host 可送給任何收看者；收看者只能送給 host |
| `member:status` | `MemberStatus` | member |
| `ping` | `{}` | 任何人 |

### 伺服器 → 客戶端

| type | payload | 對象 |
| --- | --- | --- |
| `room:snapshot` | `{ room: RoomInfo, members: Member[], stream: StreamInfo, you: { memberId, role } }` | 驗證成功的連線 |
| `room:members` | `{ members: Member[] }` | 全房 |
| `room:updated` | `{ room: RoomInfo }` | 全房 |
| `room:closed` | `{ reason: 'expired' \| 'kicked' \| 'host_closed' }` | 全房或被踢者 |
| `stream:status` | `StreamInfo` | 全房 |
| `peer:request` | `{ memberId }` | host（P2P 模式下有收看者需要連線時） |
| `signal` | `{ from: memberId, data: SignalData }` | 指定對象 |
| `member:status` | `{ memberId, status: MemberStatus }` | host |
| `ack` / `error` / `pong` | 見上 | 發送者 |

### 型別

```ts
type Mode = 'p2p' | 'relay';
type Quality = 'smooth' | 'standard' | 'high'; // 對應 streaming.md 的 720p3M / 1080p6M / 1080p8M
type RoomInfo = {
  roomId: string;
  locked: boolean;
  mode: Mode;
  quality: Quality;
  createdAt: number;
  inviteCode?: string; // 只在 host 收到的訊息中出現
};
type Member = { memberId: string; nickname: string; role: 'host' | 'member'; online: boolean };
type StreamInfo = { live: boolean; title: string | null; startedAt: number | null };
type SignalData =
  | { type: 'offer' | 'answer'; negotiationId: string; sdp: string }
  | { type: 'ice'; negotiationId: string; candidate: RTCIceCandidateInit | null };
type MemberStatus = {
  state: 'waiting' | 'connecting' | 'playing' | 'buffering' | 'failed';
  bitrateKbps?: number;
  rttMs?: number;
  packetLoss?: number; // 0–1
};
```

`title` 只用檔名（去掉副檔名），不傳送檔案路徑。

每則 P2P `signal.data` 都必須帶 `negotiationId`（shared 的 `idSchema`，1–64 字元）。房主為每份 offer 呼叫一次 `crypto.randomUUID()`，包括首次協商與每次 ICE restart。這樣停播重開、重建 transport 或換分頁後，也能為同一收看者配發新識別。收看者的 answer 與雙方的 ICE 都原樣帶上所屬 offer 的識別，包含 `candidate: null` 結束標記。

接收端按 `from` 與當前 offer 的識別比對，靜默丟棄不符的 answer 或 ICE，再對相符的訊息操作 WebRTC（見 streaming.md §3）。伺服器以 shared schema 驗證識別，依既有的成員轉送規則原樣傳遞 `data`，不儲存或比對協商狀態。

## 版本紀錄

| `PROTOCOL_VERSION` | 內容 |
| --- | --- |
| 1 | 第一版（尚未正式發布）。發布前的修改不升版：ICE 路徑由 `/api/ice` 改為 `/api/rooms/:roomId/ice`（才能驗證是哪個房間的成員）、加入關閉碼表、房主重新連線的流程、連到不存在或已關閉的房間改為接受後以 `4001` 關閉（原本回 HTTP 404）、P2P 信令必填 `data.negotiationId`、條件式加入支援 `existingRoomId` 沿用及 `excludeRoomIds` 防止重複配位。 |
