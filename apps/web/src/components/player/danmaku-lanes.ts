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
  /** 發射當下算好的頂部位置（%）；之後切換密度也不移動，直到動畫結束。 */
  topPercent: number;
  durationMs: number;
  expiresAt: number;
  isSelf: boolean;
};

/** 排程結果：放上畫面、所有軌道都忙要稍後重試，或因數量上限略過。 */
export type DanmakuScheduleResult =
  | { kind: "placed"; item: DanmakuItem }
  | { kind: "wait"; retryAt: number }
  | { kind: "drop" };

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

/** 軌道在彈幕區內的頂部百分比位置與高度。 */
export function laneBand(
  lane: number,
  density: DanmakuDensity,
): { top: number; height: number } {
  const preset = presetForDensity(density);
  const clamped = Math.max(0, Math.min(lane, preset.lanes - 1));
  const usable = Math.max(10, preset.areaPercent - 4);
  const height = usable / preset.lanes;
  return { top: 2 + clamped * height, height };
}

export function laneTopPercent(lane: number, density: DanmakuDensity): number {
  return laneBand(lane, density).top;
}

type BusyBand = { top: number; bottom: number; freeAt: number };

/** 浮點誤差容忍值：相鄰軌道邊界相接不算重疊。 */
const EPSILON = 0.001;

/**
 * 追蹤畫面上哪些高度區段還有彈幕尾巴沒離開右邊界（純邏輯，方便用假時間測試）。
 * 以絕對高度記錄而不是軌道編號，切換密度後新軌道也會避開舊彈幕。
 */
export class DanmakuScheduler {
  private busy: BusyBand[] = [];

  reset(): void {
    this.busy = [];
  }

  schedule(input: {
    id: string;
    text: string;
    density: DanmakuDensity;
    activeCount: number;
    now: number;
    isSelf: boolean;
  }): DanmakuScheduleResult {
    const preset = presetForDensity(input.density);
    if (input.activeCount >= preset.maxActive && !input.isSelf) {
      return { kind: "drop" };
    }

    this.busy = this.busy.filter((band) => band.freeAt > input.now);

    let retryAt = Number.POSITIVE_INFINITY;
    for (let lane = 0; lane < preset.lanes; lane++) {
      const { top, height } = laneBand(lane, input.density);
      const bottom = top + height;
      let blockedUntil = 0;
      for (const band of this.busy) {
        if (band.top < bottom - EPSILON && top < band.bottom - EPSILON) {
          blockedUntil = Math.max(blockedUntil, band.freeAt);
        }
      }
      if (blockedUntil === 0) {
        const durationMs = estimateDanmakuDurationMs(input.text);
        this.busy.push({
          top,
          bottom,
          freeAt: input.now + estimateLaneCooldownMs(input.text, durationMs),
        });
        return {
          kind: "placed",
          item: {
            id: input.id,
            text: input.text,
            topPercent: top,
            durationMs,
            expiresAt: input.now + durationMs + 500,
            isSelf: input.isSelf,
          },
        };
      }
      retryAt = Math.min(retryAt, blockedUntil);
    }
    // 所有軌道的入口都還有彈幕：不硬塞到同一位置，等最早空出的軌道。
    return { kind: "wait", retryAt };
  }
}
