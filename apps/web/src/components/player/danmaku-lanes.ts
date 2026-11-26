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

/** 同一軌道前後兩則彈幕之間至少保留的水平間隙（px）。 */
export const DANMAKU_GAP_PX = 24;

/**
 * 一則彈幕的滑行紀錄。動畫以進度計算位置（`translate: -進度 × (舞台寬＋文字寬)`），
 * 舞台寬度改變（例如退出全螢幕）時在途彈幕的位置會跟著變，所以紀錄不存舞台寬，
 * 每次排程都用「目前」的舞台寬度重算。
 */
export type DanmakuRun = {
  startAt: number;
  durationMs: number;
  /** 文字實際寬度（px）。 */
  width: number;
};

/**
 * 後一則彈幕 `next` 最早可以在同一軌道發射的時間，在舞台寬度 `stageWidth` 下保證全程不追撞前一則 `prev`：
 * 1. 發射當下，前一則的尾巴已離開右緣並留出間隙；
 * 2. 前一則尾巴離開左緣的那一刻，後一則的頭還在它後方至少一個間隙（後一則較快時會追上，要再晚一點發）。
 * 兩者都是線性運動，檢查頭尾兩個時間點就涵蓋整段。發射之後舞台寬度再變動則無法保證。
 */
export function earliestFollowStart(
  prev: DanmakuRun,
  next: { durationMs: number; width: number },
  stageWidth: number,
  gapPx = DANMAKU_GAP_PX,
): number {
  const prevSpeed = (stageWidth + prev.width) / prev.durationMs;
  const nextSpeed = (stageWidth + next.width) / next.durationMs;
  const tailClears = prev.startAt + (prev.width + gapPx) / prevSpeed;
  const noCatchUp =
    prev.startAt +
    prev.durationMs -
    Math.max(0, stageWidth - gapPx) / nextSpeed;
  return Math.ceil(Math.max(tailClears, noCatchUp));
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

type BusyBand = DanmakuRun & { top: number; bottom: number };

/** 浮點誤差容忍值：相鄰軌道邊界相接不算重疊。 */
const EPSILON = 0.001;

/**
 * 追蹤畫面上每個高度區段還在滑行的彈幕（純邏輯，方便用假時間測試）。
 * 以絕對高度記錄而不是軌道編號，切換密度後新軌道也會避開舊彈幕。
 * 同軌道的避讓以實際文字寬度、目前舞台寬度與滑行速度計算（見 `earliestFollowStart`）。
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
    /** 文字實際寬度（px）。 */
    textWidth: number;
    /** 舞台目前寬度（px）。 */
    stageWidth: number;
  }): DanmakuScheduleResult {
    const preset = presetForDensity(input.density);
    if (input.activeCount >= preset.maxActive && !input.isSelf) {
      return { kind: "drop" };
    }

    this.busy = this.busy.filter(
      (band) => band.startAt + band.durationMs > input.now,
    );

    const durationMs = estimateDanmakuDurationMs(input.text);
    const next = { durationMs, width: Math.max(1, input.textWidth) };
    const stageWidth = Math.max(1, input.stageWidth);
    let retryAt = Number.POSITIVE_INFINITY;
    for (let lane = 0; lane < preset.lanes; lane++) {
      const { top, height } = laneBand(lane, input.density);
      const bottom = top + height;
      let blockedUntil = 0;
      for (const band of this.busy) {
        if (band.top < bottom - EPSILON && top < band.bottom - EPSILON) {
          blockedUntil = Math.max(
            blockedUntil,
            earliestFollowStart(band, next, stageWidth),
          );
        }
      }
      if (blockedUntil <= input.now) {
        this.busy.push({ top, bottom, startAt: input.now, ...next });
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
    // 每條軌道現在發射都會碰到前一則：不硬塞，等最早安全的時間再試。
    return { kind: "wait", retryAt };
  }
}
