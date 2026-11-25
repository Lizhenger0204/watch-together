import { DEFAULT_DANMAKU_DENSITY, type DanmakuDensity } from "./danmaku-lanes";

const ENABLED_KEY = "player:danmaku:enabled";
const DENSITY_KEY = "player:danmaku:density";

export type DanmakuPrefs = {
  enabled: boolean;
  density: DanmakuDensity;
};

function isDensity(value: string | null): value is DanmakuDensity {
  return value === "low" || value === "medium" || value === "high";
}

export function loadDanmakuPrefs(): DanmakuPrefs {
  try {
    const rawEnabled = window.localStorage.getItem(ENABLED_KEY);
    const rawDensity = window.localStorage.getItem(DENSITY_KEY);
    return {
      enabled: rawEnabled === null ? true : rawEnabled === "1",
      density: isDensity(rawDensity) ? rawDensity : DEFAULT_DANMAKU_DENSITY,
    };
  } catch {
    return { enabled: true, density: DEFAULT_DANMAKU_DENSITY };
  }
}

export function saveDanmakuPrefs(prefs: DanmakuPrefs): void {
  try {
    window.localStorage.setItem(ENABLED_KEY, prefs.enabled ? "1" : "0");
    window.localStorage.setItem(DENSITY_KEY, prefs.density);
  } catch {
    // 瀏覽器停用儲存時靜默忽略，僅保留在記憶體狀態。
  }
}
