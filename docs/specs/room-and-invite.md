# 規範：房間與邀請碼

## 角色

| 角色 | 取得方式 | 權限 |
| --- | --- | --- |
| host（房主） | 建房者，持有 `hostToken` | 選片開播、切換模式、切換畫質、重新產生邀請碼、鎖房、踢人 |
| member（收看者） | 用邀請碼加入，持有 `memberToken` | 觀看 |

- 每房只有一位房主。房主斷線不轉移，房間繼續存在。**房主斷線時伺服器把直播狀態改為未開播**並通知收看者；房主重新連線後要再送 `stream:status { live: true }`。
- 房間欄位 `mode`：`p2p`（預設）或 `relay`。

## 邀請碼

- 長度 8，字元集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（去掉易混淆的 0/O/1/I/L）。
- 顯示格式 `ABCD-EFGH`。輸入時不分大小寫，忽略 `-` 與空白。
- 用 `crypto.getRandomValues` 產生（Workers 環境），不可用 `Math.random`。
- 對照表存在 `InviteDirectoryDO`（單一實例，強一致），寫入時檢查是否與現存邀請碼衝突。
- 房主可「重新產生」：舊碼立即失效，已在房內的人不受影響。
- 前端提供「複製邀請碼」與「複製邀請連結」（`/join/ABCDEFGH`）。

## Token

- `hostToken`／`memberToken`：32 bytes 隨機，base64url。伺服器只存 SHA-256 雜湊。
- 前端存在 `localStorage`（key：`room:<roomId>:token`），重新整理或重連時恢復身份。
- 傳送方式：
  - REST、WHIP、WHEP：`Authorization: Bearer <token>`。
  - WebSocket：瀏覽器無法自訂 header，**連線後第一則訊息送 `auth { token, protocolVersion }`**，5 秒內沒有通過驗證就斷線。
  - **不可放在 URL query**。

## 生命週期（RoomDO，用 Durable Object alarm 計時）

| 事件 | 行為 |
| --- | --- |
| 建房 | 狀態 `open` |
| 房主鎖房 | 狀態 `locked`，拒絕新加入，現有成員不受影響 |
| 最後一人離開 | 啟動 30 分鐘計時，期間有人回來則取消 |
| 計時到期或建房滿 24 小時 | 關閉房間、斷開所有連線、刪除邀請碼對照、釋放轉發模式的 Realtime session |

數值放在 `apps/signal/src/config.ts`，可由 `wrangler.toml` 的 `[vars]` 覆寫。

## 限制與防暴力猜測

- 每房最多 8 人（房主 + 7 位收看者，`ROOM_MAX_MEMBERS=8`），滿員回 `409 ROOM_FULL`。離線超過 10 分鐘的收看者在有人加入時會被移除以騰出名額（他們的 token 也隨之失效，要重新用邀請碼加入）。
- `POST /api/rooms/join`：每 IP（`CF-Connecting-IP`）每分鐘 10 次，超過回 `429`。使用 Workers Rate Limiting binding（`wrangler.toml` 的 `JOIN_RATE_LIMITER`）；沒有綁定時（不應發生在正式環境）不限流。
- 邀請碼錯誤、房間已關閉、已鎖房：一律回 `404 ROOM_NOT_FOUND`，不洩漏房間是否存在。
- 暱稱：1–24 字，trim 後不可為空。前端顯示時必須跳脫（React 預設會做，不可用 `dangerouslySetInnerHTML`）。

## 踢人

房主送 `room:kick` → 伺服器作廢該成員 token、斷開 WebSocket、通知房主關閉對應的 P2P 連線、廣播 `room:members`。被踢者用舊 token 重連會被拒絕。
