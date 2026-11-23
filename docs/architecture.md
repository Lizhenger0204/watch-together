# 架構總覽

決策背景見 [ADR 0002](decisions/0002-browser-live-streaming.md)。

## 系統組成

```
房主瀏覽器（桌面 Chrome / Edge）
  選本機檔案 → <video> 本地播放 → captureStream() → WebRTC 編碼
        │
        ├─ 模式 P2P：每位收看者一條 RTCPeerConnection（連不上時走 TURN）──────▶ 收看者
        └─ 模式 轉發：WHIP ─▶ Cloudflare Realtime SFU ─▶ WHEP ───────────────▶ 收看者
        │
        │ WebSocket（房間、信令）＋ REST（建房、加入、ICE、WHIP/WHEP）
        ▼
apps/signal（Hono on Cloudflare Workers）
  RoomDO（Durable Object，每房一個）：成員、角色、模式、信令轉送、生命週期
  InviteDirectoryDO：邀請碼 → roomId
  relay/：WHIP/WHEP 轉接到 Cloudflare Realtime API
  ice/：STUN 清單 + Cloudflare TURN 短效憑證
```

- **影片不經過 apps/signal**。P2P 模式直連房主；轉發模式經 Cloudflare Realtime。
- **不需要同步演算法**：所有人看同一條即時串流。房主操作本地 `<video>` 的播放、暫停、拖進度，收看者直接看到結果。
- **收看者不需要 HEVC 解碼**：房主瀏覽器解碼後重新以 H.264 編碼送出。

## 主要資料流

1. **建房**：`POST /api/rooms` → `roomId`、`inviteCode`、`hostToken`。
2. **加入**：輸入邀請碼 → `POST /api/rooms/join` → `memberToken` → 連 WebSocket 並驗證 → 收到 `room:snapshot`。
3. **開播**：房主選檔 → 格式檢查 → 本地播放 → 依房間模式建立傳輸 → 廣播 `stream:status { live: true }`。
4. **P2P**：伺服器通知房主有新收看者 → 房主建立連線並送 offer → 經 WebSocket 轉送 → 收看者回 answer → 交換 ICE → 開始收看。
5. **轉發**：房主 `POST /whip` 發布到 Realtime；收看者 `POST /whep` 拉取。
6. **切換模式**：房主送 `room:update { mode }` → 全房收到 `room:updated` → 雙方拆掉舊傳輸、建立新傳輸。

細節：房間見 [room-and-invite](specs/room-and-invite.md)、串流見 [streaming](specs/streaming.md)、格式見 [protocol](specs/protocol.md)。

## 目錄結構（pnpm workspace）

```
apps/
  web/                      Vite + React + TypeScript + Tailwind
    src/
      pages/                HomePage（建房 / 輸入邀請碼）、JoinPage（/join/:code）、RoomPage
      features/
        room/               邀請碼顯示與複製、成員列表、模式選項卡、房主操作
        source/             選檔、格式檢查、本地播放、captureStream、解析度縮放計算
        transport/          WebRTC 傳輸（純 TS，不 import React）
          p2p/              房主 mesh、收看者單一連線、信令處理
          relay/            WHIP / WHEP 客戶端
          common/           碼率控制、codec 偏好、連線統計
        player/             收看端 <video srcObject>、點擊開始觀看、狀態提示
      lib/                  api client、signal WebSocket client、token 儲存
  signal/                   Hono + Cloudflare Workers + Durable Objects
    src/
      app.ts                Hono routes
      room/                 房間核心邏輯（純函式 / 純類別，不依賴 Workers API）
      signaling/            WebSocket 訊息驗證與轉送
      relay/                WHIP / WHEP 轉接 Cloudflare Realtime
      ice/                  ICE servers 與 TURN 憑證
      runtime/workers/      RoomDO、InviteDirectoryDO、Workers 進入點
packages/
  shared/                   zod schemas、訊息型別、常數、PROTOCOL_VERSION
e2e/                        Playwright
docs/
```

## 可移植性（為了「中國大陸連不到 Cloudflare」的備案）

`apps/signal/src/room/`、`signaling/`、`relay/`、`ice/` 不可直接使用 Durable Objects 或 Workers 專屬 API，只透過 `runtime/` 提供的介面存取儲存、計時與連線。之後若要搬到香港主機，只需新增 `runtime/node/`（Node + `ws` + 記憶體儲存），其他程式不改。MVP 只實作 `runtime/workers/`。

## MVP 不做的事

帳號系統、聊天室、字幕、播放清單、每位收看者各自選模式、Android 當房主、小幫手 App、TURN 自架（coturn）。要加之前先寫 ADR。
