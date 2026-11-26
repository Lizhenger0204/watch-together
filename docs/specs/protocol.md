# 規範：通訊協定

> 本檔是契約。實作位於 `packages/shared`（zod schema + 型別 + 常數）。
> 修改流程：先改本檔 → 改 `packages/shared` → 改前後端。破壞性變更要提高 `PROTOCOL_VERSION`。

## 通用

- 時間：epoch 毫秒（number）。
- `packages/shared` 另外提供：`normalizeInviteCode` / `formatInviteCode`（前後端共用的邀請碼正規化）、`DEFAULT_QUALITY` / `resolveQuality` / `estimateSourceBitrate`（streaming.md §2 的畫質檔位與解析）、`parseClientMessage` / `parseServerMessage`（解析 WebSocket 訊息）。前後端不可自己再寫一份。
- REST 錯誤格式：`{ error: { code: ErrorCode, message: string } }`。`message` 給人看，程式判斷只看 `code`。
- `ErrorCode`：`BAD_REQUEST`、`UNAUTHORIZED`、`FORBIDDEN`、`ROOM_NOT_FOUND`、`ROOM_FULL`、`RATE_LIMITED`、`STREAM_NOT_LIVE`、`RELAY_UNAVAILABLE`、`INTERNAL`。

## REST（apps/signal）

| 方法 | 路徑 | 認證 | 請求 | 回應 |
| --- | --- | --- | --- | --- |
| POST | `/api/rooms` | 無 | `{ nickname }` | `201 { roomId, inviteCode, hostToken, memberId }` |
| POST | `/api/rooms/join` | 新加入免認證；沿用身份帶 Bearer | `{ inviteCode, nickname, existingRoomId?, excludeRoomIds?, joinKey? }` | 新加入 `200 { roomId, memberToken, memberId }`；沿用 `200 { roomId, memberId, reused: true }` |
| POST | `/api/rooms/:roomId/invite-code` | host | — | `200 { inviteCode, inviteCodeVersion }`（重新產生） |
| POST | `/api/rooms/:roomId/leave` | 任一成員 | — | `204` |
| GET | `/api/rooms/:roomId/ice` | 任一成員 | — | `200 { iceServers: RTCIceServer[] }` |
| POST | `/api/rooms/:roomId/whip` | host | SDP offer（`application/sdp`） | `201` SDP answer + `Location`；P2P 模式回 `409 STREAM_NOT_LIVE` |
| POST | `/api/rooms/:roomId/whep` | member | SDP offer | `201` SDP answer + `Location`；P2P 模式、未開播或無有效發布回 `409 STREAM_NOT_LIVE` |
| DELETE | `<Location>` | 同建立者 | — | `200` |
| GET | `/api/health` | 無 | — | `200 { ok: true, protocolVersion }` |

`POST /api/rooms/:roomId/leave` 為明確退房：移除呼叫者席位、撤銷憑證與對應 `joinKey`、清理名下轉發資源（房主同時撤下發布與綁定訂閱）；若移除後房內仍有其他成員，以 `4401` 關閉呼叫者的 WebSocket（若為房主同時停播並保留房間）；若移除後房內已無任何成員，立即關房（呼叫者的 WebSocket 收到 `room:closed` 並以 `4001` 關閉）並釋放邀請碼與轉發資源；無效憑證或房間不存在回 `401 UNAUTHORIZED`。

WHIP 只需房間已切到 relay 即可發布。P2P 模式下，WHIP 的 409 訊息為「請先切換到轉發模式再發布」，WHEP 的 409 訊息為「目前沒有可收看的轉發直播」。兩者皆用通用 REST 錯誤格式。若 SFU 建連期間已切離轉發、建立者離線，或 WHEP 所訂閱的發布已失效，即使房間又切回轉發或成員已重連，也會撤回這次登記並回 `409 STREAM_NOT_LIVE`（「房間狀態已變更，請確認轉發狀態後重試」）。踢人或淘汰成員後，舊憑證再送 WHEP 回 `401 UNAUTHORIZED`。若移除前就已驗證、移除後才登記，則回 `403 FORBIDDEN` 並回滾已建立的 tracks。

加入與沿用共用每 IP 每分鐘 10 次的限流。呼叫端可用 `excludeRoomIds` 列出已持有憑證的房間，禁止為這些房間配置新席位。帶 `existingRoomId` 時必須用 `Authorization: Bearer <token>`，且只嘗試沿用：邀請目錄與房間當下的碼皆符合、房號相同且憑證仍屬於成員，才回傳原 memberId 與 `reused: true`。客戶端保留原憑證與角色，沿用回應不含 token。鎖房與滿房不影響沿用。錯碼、錯房、沿用時的失效憑證及鎖房一律回相同的 `404 ROOM_NOT_FOUND`。只提供 header 或只提供房號也一律拒絕。新加入時，房間開放但已滿，一律回相同的 `409 ROOM_FULL` 本文。有空位才檢查排除名單，命中回 `404 ROOM_NOT_FOUND`。客戶端收到 404 或 409 都可嘗試沿用。

加入請求中的 `existingRoomId` 與 `excludeRoomIds` 接受大小寫 UUID，shared schema 驗證後一律轉成小寫再比對。

### 加入冪等（`joinKey`）

伺服器已配置席位、但回應沒被保存（例如分頁在保存身份前關閉），重試時不可再多配一席。新加入可帶 `joinKey`：

- 格式：32 bytes 隨機值的 base64url（43 字元，`^[A-Za-z0-9_-]{43}$`），與 token 同強度。客戶端用 `crypto.getRandomValues` 為每一次新的加入操作產生一把，**送出前**先寫進持久儲存。只有前一次請求結果未明（例如網路中斷、回應遺失、`500`、分頁在保存身份前關閉，或身份無法寫入持久儲存而待完成鍵已持久化）時，5 分鐘內的重試與接手的其他分頁才沿用同一把。身份成功寫入持久儲存、成功沿用既有身份，或伺服器明確未配位（錯碼／鎖房／排除名單的 `404`、滿房 `409`，以及本次新產生之鍵在進入房間前遭 `400`／`429` 等拒絕）時，條件清除自己這把鍵；之後再按「加入」即為新操作，改產生新的鍵。若既有待完成鍵在重試時遭 `429` 限流，結果仍未明，保留待完成鍵以便稍後重試。
- 伺服器在配置席位的同一筆狀態變更中記下這把鍵，期限為配置後 5 分鐘（`JOIN_KEY_TTL_MS`）。期限內再收到同一把鍵，且邀請碼仍是該房現行的碼、當時配置的成員還在，就回傳**同一份**結果 `200 { roomId, memberToken, memberId }`（同一個 token），不再配置席位。這時不檢查鎖房、滿房與 `excludeRoomIds`，也不採用新的暱稱。
- 鍵已過期、不認得，或當時的成員已被踢出或淘汰：視為一般新加入，照常檢查鎖房、滿房與排除名單，成功時記下這把鍵。
- 帶 `existingRoomId` 的沿用請求忽略 `joinKey`。格式錯誤回 `400 BAD_REQUEST` 及通用錯誤本文。沒有新的錯誤碼，錯碼、鎖房、滿房的回應和不帶鍵時完全相同。重放也計入同一個每 IP 每分鐘 10 次的限流。
- 邀請碼重新產生時，伺服器在同一筆換碼交易中清空先前邀請碼配發的 `joinKeys` 紀錄（既有成員與憑證不受影響）：舊碼照常回 `404`，新碼也不能命中舊碼時期的紀錄，鍵不能跨碼使用。多出的席位要等房主踢除或離線淘汰。

鍵與 token 的關係與安全：

- `joinKey` 只能在期限內、搭配該房現行邀請碼，取回**用這把鍵配置的那一份**身份，不能用來連 WebSocket、ICE、WHIP、WHEP，也不能取得其他成員的身份。要冒用別人的席位，必須拿到對方的鍵（256 位元隨機值，只存在對方瀏覽器）。
- 持有鍵等同持有那份 memberToken，所以鍵是機密：只放在 HTTPS 請求本文，不可寫進 URL、log、錯誤訊息或畫面。
- 伺服器不保存鍵與 token 的明文：以鍵經 HKDF-SHA-256（salt 為 roomId）導出兩個值，一個當查表識別，一個是 AES-GCM 金鑰，用來加密這次配發的 token（附加資料為 memberId）。重放時用請求帶來的鍵解密取回 token。storage 外洩也拿不到 token，和只存 token 雜湊的原則一致。
- 紀錄存在房間狀態裡，在 `changes` 佇列內查表、寫表，與席位同一筆交易提交。每次記下新鍵時清掉已過期、成員已不在的紀錄，所以筆數不超過房間人數上限。關房時隨房間狀態一起刪除。

每次加入最多可列 16 個 `excludeRoomIds`。16 個 UUID 的緊湊 JSON 陣列為 625 位元組，足以在單次請求保護多房身份。整份加入請求的 UTF-8 本文上限為 2,048 位元組，保留暱稱、邀請碼、其他欄位與排版空間。恰好達到任一上限可接受。房號過多或實際本文超限都回 `400 BAD_REQUEST` 及通用錯誤本文。伺服器在解析 JSON 前計算串流位元組，超限即停止讀取。

## WebSocket

- 路徑：`/api/rooms/:roomId/ws`。
- 房間不存在、已關閉、正在關房，或 `roomId` 格式錯誤時，伺服器仍接受 upgrade，接著立刻以 `4001`（reason `room_closed`）關閉，不送任何訊息。四種情況的回應完全相同，不透露房間是否曾經存在。不直接回 HTTP 錯誤，是因為瀏覽器的 WebSocket 只看得到 `1006`，前端會一直退避重連。不是 upgrade 的請求仍回 `426`。
- 每則訊息為 JSON：`{ type: string, ...payload }`，用 `packages/shared` 的 discriminated union schema 解析。已驗證的連線解析失敗：回 `error` 並忽略該訊息；**未驗證的連線解析失敗：直接以 `4400` 關閉**。
- 第一則訊息必須是 `auth`，否則以 `4400` 斷線（見 room-and-invite.md）。5 秒期限以伺服器算完 token 雜湊的時間判斷。
- 需要回應的請求帶 `reqId`，伺服器回 `ack { reqId, ok: true } | { reqId, ok: false, code }`。
- 心跳：客戶端每 20 秒送 `ping`，伺服器回 `pong`（分頁切回前景時前端也會立即補送一次 `ping`）。已驗證連線超過 `WS_HEARTBEAT_TIMEOUT_MS`（130 秒，大於瀏覽器背景分頁 60 秒計時器節流週期的兩倍）未收到任何客戶端訊息時，伺服器以關閉碼 `4410`（reason `heartbeat_timeout`）關閉該連線並觸發離線處理（離線起算時間為判定逾時當下，讓房主重連保有完整的 100 秒寬限）。
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
| `4410` | 心跳逾時 | 視為網路中斷，指數退避重連 |
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
| `chat:send` | `{ text }`（可帶 `reqId`） | 任何已驗證成員（host / member） |
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
| `chat:message` | `ChatMessage` | 全房在線成員（含發送者） |
| `ack` / `error` / `pong` | 見上 | 發送者 |

### 型別

```ts
type Mode = 'p2p' | 'relay';
// streaming.md §2 的三條畫質滑桿檔位；'source' 代表沿用原片。三個欄位都必填，不可有其他欄位。
type Quality = {
  height: 720 | 900 | 1080;
  bitrate: 8_000_000 | 10_000_000 | 15_000_000 | 'source'; // bps
  fps: 24 | 30 | 60 | 'source';
};
type RoomInfo = {
  roomId: string;
  locked: boolean;
  mode: Mode;
  quality: Quality;
  createdAt: number;
  inviteCode?: string; // 只在 host 收到的訊息中出現
  inviteCodeVersion?: number; // 只在 host 收到的訊息中出現，初始 0，每次換碼遞增
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
type ChatMessage = {
  id: string;
  memberId: string;
  nickname: string;
  role: 'host' | 'member';
  text: string;
  sentAt: number;
};
```

`title` 只用檔名（去掉副檔名），不傳送檔案路徑。

### 聊天訊息（`chat:send` / `chat:message`）

- `text`：原始字串上限 1,000 字（`CHAT_RAW_MAX_LENGTH`）；解析時會將換行正規化為空白並移除前後空白，正規化後須為 1–200 字（`CHAT_MAX_LENGTH`）。**字數一律以 Unicode code point 計算**（一個 emoji 算 1 字，不是 JavaScript 的 `.length`）；正規化與計數只用 shared 的 `normalizeChatText()`、`chatTextLength()`，前端輸入框、字數提示與送出檢查不可自行計算。輸入框不截斷文字（不可用 `maxLength`，那是 UTF-16 長度，也會吃掉送出失敗時放回的草稿）；原始字數或正規化後字數超過上限時停用送出並提示。空字串、純空白或超長都由 schema 拒絕，已驗證連線回 `BAD_REQUEST`（未驗證以 `4400` 關閉）。
- **身份與權限**：房主與收看者皆可發言。`memberId`、`nickname`、`role`、`id`、`sentAt` 一律由伺服器依當下房間成員狀態與伺服器時間填入，不採信客戶端。被踢出或已不在房間成員清單的連線送出時以 `4401` 關閉，不廣播。
- **限流**：每位成員每 10 秒最多 5 則（`CHAT_RATE_LIMIT_MAX=5`、`CHAT_RATE_LIMIT_WINDOW_MS=10_000`）。超過時拒絕且不廣播：帶 `reqId` 回 `ack { reqId, ok: false, code: 'RATE_LIMITED' }`，否則回 `error { code: 'RATE_LIMITED', message }`。限流紀錄只放在房間 DO 的記憶體，不寫入 storage：DO 要閒置超過 10 秒才會休眠，屆時窗口已過，一般休眠不影響；同一 DO 實例內重連仍沿用原額度。**例外**：部署或執行環境重啟若發生在窗口內，額度會提早恢復，這是可接受的取捨。
- **不保留歷史紀錄**：伺服器不持久化聊天訊息，`room:snapshot` 不包含歷史聊天；加入房間後只看得到之後發出的訊息。房主不需要禁言或刪除訊息。
- **顯示**：前端聊天室與彈幕一律以純文字呈現，不可用 `dangerouslySetInnerHTML`。

每則 P2P `signal.data` 都必須帶 `negotiationId`（shared 的 `idSchema`，1–64 字元）。房主為每份 offer 呼叫一次 `crypto.randomUUID()`，包括首次協商與每次 ICE restart。這樣停播重開、重建 transport 或換分頁後，也能為同一收看者配發新識別。收看者的 answer 與雙方的 ICE 都原樣帶上所屬 offer 的識別，包含 `candidate: null` 結束標記。

接收端按 `from` 與當前 offer 的識別比對，靜默丟棄不符的 answer 或 ICE，再對相符的訊息操作 WebRTC（見 streaming.md §3）。伺服器以 shared schema 驗證識別，依既有的成員轉送規則原樣傳遞 `data`，不儲存或比對協商狀態。

## 版本紀錄

| `PROTOCOL_VERSION` | 內容 |
| --- | --- |
| 1 | 第一版（尚未正式發布）。發布前的修改不升版：ICE 路徑由 `/api/ice` 改為 `/api/rooms/:roomId/ice`（才能驗證是哪個房間的成員）、加入關閉碼表、房主重新連線的流程、連到不存在或已關閉的房間改為接受後以 `4001` 關閉（原本回 HTTP 404）、P2P 信令必填 `data.negotiationId`、條件式加入支援 `existingRoomId` 沿用及 `excludeRoomIds` 防止重複配位、加入可帶 `joinKey` 重試時沿用已配置的席位、換碼 REST 與房主 `RoomInfo` 帶單調遞增的 `inviteCodeVersion`、`Quality` 由三個預設名稱改為解析度／位元率／FPS 三個檔位的物件（T-126；伺服器讀到舊房間存的預設名稱時回到預設畫質）、新增聊天訊息 `chat:send` 與 `chat:message`（T-127；不保留歷史紀錄，每成員每 10 秒限 5 則，長度上限 200 字）、伺服器端心跳逾時 130 秒以 `4410` 關閉並自判定逾時當下起算離線，房主離線滿 100 秒自動移除席位（有收看者則保留房間並提示房主已離開、不再接受新加入，無成員或無人滿 100 秒釋放房間）、新增 `POST /api/rooms/:roomId/leave` 明確退房與成員歸零／無人 100 秒釋放空房規則。 |
