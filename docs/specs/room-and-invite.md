# 規範：房間與邀請碼

## 角色

| 角色 | 取得方式 | 權限 |
| --- | --- | --- |
| host（房主） | 建房者，持有 `hostToken` | 選片開播、切換模式、切換畫質、重新產生邀請碼、鎖房、踢人 |
| member（收看者） | 用邀請碼加入，持有 `memberToken` | 觀看 |

- 每房只有一位房主。房主斷線不轉移，房間繼續存在。**房主斷線或重新驗證（含另一分頁以 4000 取代）時，伺服器把直播狀態改為未開播**並通知收看者。房主重新連線並準備好片源後要再送 `stream:status { live: true, title }`。
- 房間欄位 `mode`：`p2p`（預設）或 `relay`。

## 邀請碼

- 長度 8，字元集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（去掉易混淆的 0/O/1/I/L）。
- 顯示格式 `ABCD-EFGH`。輸入時不分大小寫，忽略 `-` 與空白。
- 用 `crypto.getRandomValues` 產生（Workers 環境），不可用 `Math.random`。
- 對照表存在 `InviteDirectoryDO`（單一實例，強一致），寫入時檢查是否與現存邀請碼衝突。
- 房主可「重新產生」：舊碼立即失效，已在房內的人不受影響。
- 前端提供「複製邀請碼」與「複製邀請連結」（`/join/ABCDEFGH`）。

## Token

- `hostToken`／`memberToken`：32 bytes 隨機，base64url。伺服器只存 SHA-256 雜湊，比對時用常數時間比較、逐一比完所有成員。
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
| 計時到期或建房滿 24 小時 | 關閉房間、斷開所有連線、刪除邀請碼對照、關閉轉發模式的 Realtime tracks |

關房分兩步：

1. 先在 storage 用同一筆交易記下「關房中」並刪掉房間狀態，**提交成功後**才通知成員（`room:closed`）並以 `4001` 斷線。提交失敗時房間維持原狀，下次 alarm 再關。之後的加入、連線、WHIP／WHEP 一律視為房間不存在。
2. 再清理外部資源：邀請碼對照、轉發 tracks。**邀請碼與每個轉發資源各自嘗試、完成一項就保存一項**，其中一項失敗不會擋住其他項。

有沒做完的就用 alarm 重試：間隔 30 秒起，每次加倍，最多 1 小時。**最多嘗試 12 次，包含關房當下的第一次**（即第一次之後再重試 11 次）。全部完成才刪除這個房間的 storage。

12 次都沒做完就放棄：記錄 `room.cleanup_gave_up`（只記次數與剩餘數量，不記邀請碼或 session），不再排 alarm。storage 裡**保留沒做完的紀錄**，包括還沒釋放的邀請碼、還沒查回結果的換碼操作、還沒關閉的轉發資源，以及嘗試次數。房間狀態與成員資料在第 1 步就已刪除，不會保留。留著的邀請碼對照仍指向這個房間，但房間已不存在，用它加入一樣回 `404`。

到期關房（閒置 30 分鐘或滿 24 小時）會在取得執行權時用最新狀態重算期限。排隊期間如果有人回來，或計時已重設，就不關房，改排下一次 alarm。

重新產生邀請碼與關房在 RoomDO 內依序執行：**最後一次換到的碼有效，對照表不留孤兒**。依序執行時，第二次重產本來就會讓第一次的碼失效；同時送出多個重產請求時，前端以最後收到的回應為準。

換碼時，RoomDO 先在 storage 記下這次操作的識別碼（opId），再請邀請目錄換碼。邀請目錄用 opId 記住每個房間最後一次換到的碼，同一個 opId 再呼叫會回傳同一個結果。所以邀請目錄已經換好、但 RPC 回應遺失時，下次重產或關房會用同一個 opId 查回那個碼，先套用或釋放，不會留下孤兒。

數值放在 `apps/signal/src/config.ts`，可由 `wrangler.toml` 的 `[vars]` 覆寫。

## 限制與防暴力猜測

- 每房最多 8 人（房主 + 7 位收看者，`ROOM_MAX_MEMBERS=8`），滿員回 `409 ROOM_FULL`。離線超過 10 分鐘的收看者在有人加入時會被移除以騰出名額（他們的 token 也隨之失效，要重新用邀請碼加入）。
- `POST /api/rooms/join`：每 IP（`CF-Connecting-IP`）每分鐘 10 次，超過回 `429`。使用 Workers Rate Limiting binding（`wrangler.toml` 的 `JOIN_RATE_LIMITER`）。沒有綁定或綁定出錯時，改用記憶體後備限流（同樣每 IP 每分鐘 10 次，只在單一 isolate 內計數，並記錄 `ratelimit.fallback`）。
- 邀請碼錯誤、房間已關閉、已鎖房：一律回 `404 ROOM_NOT_FOUND`，不洩漏房間是否存在。
- 暱稱：1–24 字，trim 後不可為空。前端顯示時必須跳脫（React 預設會做，不可用 `dangerouslySetInnerHTML`）。

## 踢人

房主送 `room:kick` → 伺服器作廢該成員 token、斷開 WebSocket、通知房主關閉對應的 P2P 連線、廣播 `room:members`。被踢者用舊 token 重連會被拒絕。
