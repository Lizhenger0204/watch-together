import { CLOSE } from "../../signaling/process";

/**
 * 房間不存在、已關閉或關房中時回應 WebSocket upgrade：先接受再立刻以 4001 關閉。
 * 直接回 HTTP 錯誤的話，瀏覽器只看得到 1006，前端會一直退避重連。
 * 不論房間是否曾經存在，回應都一樣（不送 room:closed，只有關閉碼與 reason）。
 * 用一般的 accept() 而非 Hibernation API：這條連線不會出現在 getWebSockets()，
 * 不影響關房清理與 alarm 排程。
 */
export function roomClosedSocket(): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(CLOSE.ROOM_CLOSED, "room_closed");
  return new Response(null, { status: 101, webSocket: client });
}
