import type { TransportStats } from "../transport";
import type { SessionTimers } from "./viewer-session";

// 房主端「編碼跟不上」即時提示的純判斷邏輯（docs/specs/streaming.md §2、§8）。

/** 連續符合條件或連續不成立達此時間，才切換提示狀態。 */
export const ENCODER_LAG_DURATION_MS = 10_000;

/** 送出 FPS 低於目標幀率此比例視為跟不上。 */
export const ENCODER_LAG_FPS_RATIO = 0.7;

export const ENCODER_LAG_MESSAGE =
  "房主電腦編碼跟不上，建議調低解析度或改用轉發";

export type SenderEncoderState = {
  lagging: boolean;
  laggingSince: number | null;
};

export type EncoderHealthState = {
  /** 目前是否應顯示「編碼跟不上」提示。 */
  lagging: boolean;
  /** 各 video sender（P2P 為 memberId，relay 為單一鍵）的最新狀態與連續跟不上起始時間。 */
  senders: Readonly<Record<string, SenderEncoderState>>;
  /** 所有 sender 都不再符合條件的起始時間（用於連續 10 秒清除提示）。 */
  clearSince: number | null;
};

export function initialEncoderHealth(): EncoderHealthState {
  return { lagging: false, senders: {}, clearSince: null };
}

/**
 * 計算用來對照送出 FPS 的目標幀率（streaming.md §2）：
 * 優先用 `maxFramerate`；原片 FPS（null）時用片源 FPS（`track.getSettings().frameRate`）；
 * 兩者都量不到時回 null，不判斷 FPS 條件。
 */
export function targetFramerate(
  maxFramerate: number | null,
  sourceFps?: number | null,
): number | null {
  if (
    maxFramerate !== null &&
    Number.isFinite(maxFramerate) &&
    maxFramerate > 0
  ) {
    return maxFramerate;
  }
  if (
    sourceFps !== null &&
    sourceFps !== undefined &&
    Number.isFinite(sourceFps) &&
    sourceFps > 0
  ) {
    return sourceFps;
  }
  return null;
}

/** 單次房主統計是否符合「編碼跟不上」條件（CPU 受限或送出 FPS < 目標 70%）。 */
export function isSampleLagging(
  stats: Pick<TransportStats, "framesPerSecond" | "qualityLimitationReason">,
  targetFps: number | null,
): boolean {
  if (stats.qualityLimitationReason === "cpu") return true;
  if (
    targetFps !== null &&
    Number.isFinite(targetFps) &&
    targetFps > 0 &&
    stats.framesPerSecond !== undefined &&
    Number.isFinite(stats.framesPerSecond) &&
    stats.framesPerSecond < targetFps * ENCODER_LAG_FPS_RATIO
  ) {
    return true;
  }
  return false;
}

/**
 * 記錄某個 video sender 的一次統計取樣並推進狀態。
 * - 任一 sender 連續 10 秒符合條件即觸發 `lagging = true`。
 * - P2P 多位收看者各自記錄，其他收看者的正常樣本不會重設正在跟不上的那一位。
 * - 所有 sender 連續 10 秒都不符合條件時清除 `lagging`。
 */
export function recordEncoderSample(
  state: EncoderHealthState,
  sample: {
    senderId: string;
    stats: Pick<TransportStats, "framesPerSecond" | "qualityLimitationReason">;
    targetFps: number | null;
    now: number;
  },
): EncoderHealthState {
  const { senderId, stats, targetFps, now } = sample;
  const sampleLagging = isSampleLagging(stats, targetFps);
  const prev = state.senders[senderId];
  const nextSender: SenderEncoderState = sampleLagging
    ? { lagging: true, laggingSince: prev?.laggingSince ?? now }
    : { lagging: false, laggingSince: null };
  const senders = { ...state.senders, [senderId]: nextSender };

  const anyLagging = Object.values(senders).some((entry) => entry.lagging);
  if (anyLagging) {
    const triggered =
      sampleLagging &&
      nextSender.laggingSince !== null &&
      now - nextSender.laggingSince >= ENCODER_LAG_DURATION_MS;
    return {
      lagging: state.lagging || triggered,
      senders,
      clearSince: null,
    };
  }

  if (!state.lagging) {
    return { lagging: false, senders, clearSince: null };
  }
  const clearSince = state.clearSince ?? now;
  if (now - clearSince >= ENCODER_LAG_DURATION_MS) {
    return { lagging: false, senders, clearSince: null };
  }
  return { lagging: true, senders, clearSince };
}

/** 收看者離開或被移除連線時清掉它的紀錄；若已無其他跟不上的 sender，開始 10 秒清除計時。 */
export function removeEncoderSender(
  state: EncoderHealthState,
  senderId: string,
  now: number,
): EncoderHealthState {
  if (!(senderId in state.senders)) return state;
  const senders = { ...state.senders };
  delete senders[senderId];
  const anyLagging = Object.values(senders).some((entry) => entry.lagging);
  if (!anyLagging && state.lagging) {
    return { lagging: true, senders, clearSince: state.clearSince ?? now };
  }
  return { ...state, senders };
}

/** 推進清除計時（例如最後一位收看者離線後，沒有後續統計樣本仍能在滿 10 秒時清除提示）。 */
export function checkEncoderClear(
  state: EncoderHealthState,
  now: number,
): EncoderHealthState {
  if (
    state.lagging &&
    state.clearSince !== null &&
    now - state.clearSince >= ENCODER_LAG_DURATION_MS
  ) {
    return { ...state, lagging: false, clearSince: null };
  }
  return state;
}

/** HostSession 用的狀態包裝，負責在無新樣本時於滿 10 秒自動清除提示。 */
export class EncoderHealthTracker {
  private state: EncoderHealthState = initialEncoderHealth();
  private clearTimer: unknown = null;

  constructor(
    private readonly hooks: {
      timers: SessionTimers;
      now: () => number;
      changed: () => void;
    },
  ) {}

  get lagging(): boolean {
    return this.state.lagging;
  }

  observe(
    senderId: string,
    stats: Pick<TransportStats, "framesPerSecond" | "qualityLimitationReason">,
    targetFps: number | null,
  ): void {
    const now = this.hooks.now();
    this.update(
      recordEncoderSample(this.state, { senderId, stats, targetFps, now }),
      now,
    );
  }

  removeSender(senderId: string): void {
    const now = this.hooks.now();
    this.update(removeEncoderSender(this.state, senderId, now), now);
  }

  /** 停播、換畫質或銷毀時立即清除提示與所有累計時間。 */
  reset(): void {
    this.clearScheduled();
    const wasLagging = this.state.lagging;
    this.state = initialEncoderHealth();
    if (wasLagging) this.hooks.changed();
  }

  private update(next: EncoderHealthState, now: number): void {
    const wasLagging = this.state.lagging;
    this.state = next;
    this.syncTimer(now);
    if (wasLagging !== next.lagging) this.hooks.changed();
  }

  private syncTimer(now: number): void {
    if (!this.state.lagging || this.state.clearSince === null) {
      this.clearScheduled();
      return;
    }
    if (this.clearTimer !== null) return;
    const remaining = Math.max(
      0,
      ENCODER_LAG_DURATION_MS - (now - this.state.clearSince),
    );
    this.clearTimer = this.hooks.timers.setTimeout(() => {
      this.clearTimer = null;
      const currentNow = this.hooks.now();
      this.update(checkEncoderClear(this.state, currentNow), currentNow);
    }, remaining);
  }

  private clearScheduled(): void {
    if (this.clearTimer === null) return;
    this.hooks.timers.clearTimeout(this.clearTimer);
    this.clearTimer = null;
  }
}
