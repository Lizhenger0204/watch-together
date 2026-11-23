# 程式風格

## 通用

- TypeScript `strict: true`，禁止 `any`（真的需要用 `unknown` 再收窄）。
- ESM（`"type": "module"`）。格式化交給 Prettier，lint 用 ESLint（typescript-eslint recommended）。不要手動爭論格式。
- 檔名 `kebab-case.ts`；React 元件 `PascalCase.tsx`；型別 `PascalCase`；常數 `UPPER_SNAKE_CASE`。
- 程式碼與識別字用英文；註解、UI 文字可用繁體中文。只寫「為什麼」的註解。
- 所有外部輸入（HTTP body、WebSocket 訊息、環境變數、Realtime API 回應）都用 `packages/shared` 或模組內的 zod schema 解析後才使用。

## 後端（apps/signal）

- 業務邏輯（房間、邀請碼、信令轉送規則）寫成**不依賴 Hono、Workers、Durable Objects 的純模組**，route 與 DO 只做解析、驗權、呼叫、回應。
- 需要時間的函式接收 `now` 參數（或注入 clock），方便測試。
- 錯誤用自訂 `AppError(code, message)`，由統一 handler 轉成協定錯誤格式。不要把 stack trace 回給客戶端。
- log 用 `console.log` 輸出結構化 JSON（Workers Logs 會收集）。**禁止 log token、SDP 全文、TURN 憑證、完整邀請碼**（邀請碼可只記前 2 碼）。

## 前端（apps/web）

- 函式元件 + hooks。全域狀態先用 React context + `useReducer`，不夠再討論是否引入 Zustand（需 ADR）。
- `features/transport/` 必須是純 TS（不 import React），由 hook 包一層給元件使用；`RTCPeerConnection` 包在介面後面，方便用 fake 測試。
- 不直接在元件裡呼叫 `fetch`／`WebSocket`，經 `lib/api.ts`、`lib/signal.ts`。
- 每個 `RTCPeerConnection`、`MediaStreamTrack`、object URL 都要在元件卸載或換片時釋放（`close()`、`stop()`、`revokeObjectURL()`）。
- UI 文字繁體中文。

## 依賴

新增 runtime 依賴前在任務交接備註說明理由；大型依賴（狀態管理、UI 框架、ORM）需寫 ADR。
