/** 彈幕密度檔位（streaming.md §1）。 */
export type DanmakuDensity = "low" | "medium" | "high";

export type DanmakuPreset = {
  value: DanmakuDensity;
  label: string;
  /** 可用軌道數。 */
  lanes: number;
  /** 佔播放器高度百分比（從頂部往下算，底部避開控制列）。 */
  areaPercent: number;
  /** 同螢幕最多顯示幾條彈幕；超過時非本人訊息依密度節流。 */
  maxActive: number;
};

export const DANMAKU_PRESETS: readonly DanmakuPreset[] = [
  { value: "low", label: "少", lanes: 3, areaPercent: 25, maxActive: 12 },
  { value: "medium", label: "中", lanes: 6, areaPercent: 50, maxActive: 24 },
  { value: "high", label: "多", lanes: 10, areaPercent: 80, maxActive: 40 },
] as const;

export const DEFAULT_DANMAKU_DENSITY: DanmakuDensity = "medium";

export type DanmakuItem = {
  id: string;
  text: string;
  lane: number;
  durationMs: number;
  expiresAt: number;
  isSelf: boolean;
};

export function presetForDensity(density: DanmakuDensity): DanmakuPreset {
  return (
    DANMAKU_PRESETS.find((preset) => preset.value === density) ??
    DANMAKU_PRESETS[1]!
  );
}

/** 依字數微調滑行時間（7.5s～10.2s），避免長句飛得太快難讀。 */
export function estimateDanmakuDurationMs(text: string): number {
  return 7_500 + Math.min(text.length, 60) * 45;
}

/** 粗估這條彈幕完全離開右邊界並留出間隙所需的時間，供同軌道排程避讓。 */
export function estimateLaneCooldownMs(
  text: string,
  durationMs: number,
): number {
  const ratio = 0.14 + Math.min(text.length, 40) * 0.012;
  return Math.min(
    Math.round(durationMs * 0.75),
    Math.max(1_200, Math.round(durationMs * ratio)),
  );
}

/** 計算軌道在彈幕區內的頂部百分比位置。 */
export function laneTopPercent(lane: number, density: DanmakuDensity): number {
  const preset = presetForDensity(density);
  const clamped = Math.max(0, Math.min(lane, preset.lanes - 1));
  const usable = Math.max(10, preset.areaPercent - 4);
  return 2 + (clamped / preset.lanes) * usable;
}

/**
 * 追蹤每條軌道下一次可放新彈幕的時間（純邏輯，方便用假時間測試）。
 */
export class DanmakuScheduler {
  private laneFreeAt: number[] = [];

  reset(): void {
    this.laneFreeAt = [];
  }

  schedule(input: {
    id: string;
    text: string;
    density: DanmakuDensity;
    activeCount: number;
    now: number;
    isSelf: boolean;
  }): DanmakuItem | null {
    const preset = presetForDensity(input.density);
    if (input.activeCount >= preset.maxActive && !input.isSelf) {
      return null;
    }

    while (this.laneFreeAt.length < preset.lanes) {
      this.laneFreeAt.push(0);
    }

    let chosen = -1;
    for (let i = 0; i < preset.lanes; i++) {
      if (this.laneFreeAt[i]! <= input.now) {
        chosen = i;
        break;
      }
    }
    if (chosen < 0) {
      // 所有軌道都還在忙：挑最早釋放的那一條，盡量拉開間距。
      chosen = 0;
      for (let i = 1; i < preset.lanes; i++) {
        if (this.laneFreeAt[i]! < this.laneFreeAt[chosen]!) chosen = i;
      }
    }

    const durationMs = estimateDanmakuDurationMs(input.text);
    const cooldownMs = estimateLaneCooldownMs(input.text, durationMs);
    this.laneFreeAt[chosen] =
      Math.max(this.laneFreeAt[chosen]!, input.now) + cooldownMs;

    return {
      id: input.id,
      text: input.text,
      lane: chosen,
      durationMs,
      expiresAt: input.now + durationMs + 500,
      isSelf: input.isSelf,
    };
  }
}
