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
| POST | `/api/rooms/join` | 無 | `{ inviteCode, nickname }` | `200 { roomId, memberToken, memberId }` |
| POST | `/api/rooms/:roomId/invite-code` | host | — | `200 { inviteCode }`（重新產生） |
| GET | `/api/rooms/:roomId/ice` | 任一成員 | — | `200 { iceServers: RTCIceServer[] }` |
| POST | `/api/rooms/:roomId/whip` | host | SDP offer（`application/sdp`） | `201` SDP answer + `Location` |
| POST | `/api/rooms/:roomId/whep` | member | SDP offer | `201` SDP answer + `Location`；未開播 `409 STREAM_NOT_LIVE` |
| DELETE | `<Location>` | 同建立者 | — | `200` |
| GET | `/api/health` | 無 | — | `200 { ok: true, protocolVersion }` |

## WebSocket

- 路徑：`/api/rooms/:roomId/ws`。
- 每則訊息為 JSON：`{ type: string, ...payload }`，用 `packages/shared` 的 discriminated union schema 解析。已驗證的連線解析失敗：回 `error` 並忽略該訊息；**未驗證的連線解析失敗：直接以 `4400` 關閉**。
- 第一則訊息必須是 `auth`，否則以 `4400` 斷線（見 room-and-invite.md）。5 秒期限以伺服器算完 token 雜湊的時間判斷。
- 需要回應的請求帶 `reqId`，伺服器回 `ack { reqId, ok: true } | { reqId, ok: false, code }`。
- 心跳：客戶端每 20 秒送 `ping`，伺服器回 `pong`。
- 同一成員只保留一條連線：新連線驗證成功後，舊連線以 `4000` 關閉。

### 房主重新連線（重新整理、另一分頁取代 `4000`、斷線重連）

房主每次驗證成功，都視為新的直播工作階段，伺服器依序：

1. 若原本在直播，改為未開播，對其他在線成員送 `stream:status { live: false }`（收看者關閉舊的 P2P 連線或 WHEP）。
2. 回房主 `room:snapshot`，其中 `stream.live` 為 `false`。
3. 房主端若仍有可播放的片源，再送 `stream:status { live: true, title }`。
4. 伺服器廣播 `stream:status`，P2P 模式下對每位在線收看者送一則 `peer:request` 給房主。

房主端不能假設重連後還是開播狀態，也不需要自己記住要連哪些收看者；以伺服器送來的 `peer:request` 為準。

### 關閉碼

| code | 意義 | 客戶端該做什麼 |
| --- | --- | --- |
| `4000` | 被同一成員的新連線取代 | 不要自動重連（另一個分頁接手了） |
| `4001` | 房間已關閉 | 回首頁 |
| `4003` | 被踢出 | 清除 token，回首頁 |
| `4400` | 格式錯誤或未驗證就送訊息、協定版本不符 | 重新整理頁面 |
| `4401` | token 無效 | 清除 token，回首頁 |
| `4408` | 5 秒內沒有送 `auth` | 重連 |
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
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit | null }; // null 代表 end-of-candidates
type MemberStatus = {
  state: 'waiting' | 'connecting' | 'playing' | 'buffering' | 'failed';
  bitrateKbps?: number;
  rttMs?: number;
  packetLoss?: number; // 0–1
};
```

`title` 只用檔名（去掉副檔名），不傳送檔案路徑。

## 版本紀錄

| `PROTOCOL_VERSION` | 內容 |
| --- | --- |
| 1 | 第一版（尚未正式發布）。發布前的修改不升版：ICE 路徑由 `/api/ice` 改為 `/api/rooms/:roomId/ice`（才能驗證是哪個房間的成員）、加入關閉碼表、房主重新連線的流程。 |
