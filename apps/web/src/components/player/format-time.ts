/** 播放器時間顯示：`m:ss`，一小時以上為 `h:mm:ss`。負數、NaN 與無限大視為 0。 */
export function formatTime(value: number): string {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts
    .map((part, index) => String(part).padStart(index === 0 ? 1 : 2, "0"))
    .join(":");
}
