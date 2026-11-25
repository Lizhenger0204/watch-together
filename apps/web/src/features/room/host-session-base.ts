import type { Mode, Quality } from "@project/shared";
import { ApiError } from "../../lib/api";
import {
  type CreateHostTransport,
  type HostTransport,
  type TransportSignal,
} from "../transport";
import type { HostSessionOptions, HostSource, Op } from "./host-session-types";
import type { TitleSync } from "./host-session-title";
import type { SessionTimers } from "./viewer-session";

/** 切模式第 2 步：等 `room:updated` 廣播的期限（§6）。 */
export const MODE_UPDATED_TIMEOUT_MS = 10_000;

/**
 * HostSession 的抽象基類，把兩個「送出請求／建立傳輸」的功能抽出來：
 * - confirmStop／confirmMode：送 stream:status／room:update，等 ack 或廣播，含逾時與到期語意。
 *   直播中的片名更新在 host-session-title.ts。
 * - build：依目前狀態建立 host transport 並接上信令與狀態回呼。
 * 這些方法會改動 session 狀態，因此狀態欄位宣告為 abstract，由 HostSession 提供。
 */
export abstract class HostSessionBase {
  protected abstract source: HostSource;
  protected abstract generation: number;
  protected abstract serverLive: boolean;
  protected abstract titles: TitleSync;
  protected abstract stopWaiter: (() => void) | null;
  protected abstract modeWaiter: { mode: Mode; resolve: () => void } | null;
  protected abstract modeTimer: unknown;
  protected abstract options: HostSessionOptions;
  protected abstract timers: SessionTimers;
  protected abstract mode: Mode;
  protected abstract quality: Quality;
  protected abstract closed: boolean;
  protected abstract destroyed: boolean;
  protected abstract op: Op | null;
  /** 開播流程中 start() 已完成的傳輸世代：之後在等停播或 live:true 的確認。 */
  protected abstract readyGeneration: number | null;
  protected abstract signalHandler:
    Parameters<TransportSignal["onSignal"]>[0] | null;
  protected abstract peerHandler:
    Parameters<TransportSignal["onPeerRequest"]>[0] | null;
  protected abstract createTransport: CreateHostTransport;

  protected abstract publish(): void;
  protected abstract showError(error: unknown): void;
  protected abstract failLive(duringStart?: boolean): void;

  /**
   * 送停播；同一 reqId 的 ack 或之後的 live:false 廣播先到者為確認。
   * 開始停播就讓還沒確認的片名請求作廢。ack 晚到（已由廣播確認、或已被重新驗證作廢）時
   * 不寫入 serverLive：那時伺服器可能已經重新開播。
   */
  protected confirmStop(): Promise<void> {
    this.titles.invalidate();
    return new Promise((resolve, reject) => {
      let settled = false;
      const onBroadcast = () => settle(resolve);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.stopWaiter === onBroadcast) this.stopWaiter = null;
        fn();
      };
      this.stopWaiter = onBroadcast;
      this.options.client
        .request({ type: "stream:status", live: false, title: null })
        .then(
          () => {
            if (!settled && this.stopWaiter === onBroadcast) {
              this.serverLive = false;
              this.titles.server = null;
            }
            settle(resolve);
          },
          (error: unknown) => settle(() => reject(error)),
        );
    });
  }

  /** 送 room:update { mode }，收到該模式的 room:updated 才 resolve；超過期限就 reject。 */
  protected confirmMode(target: Mode): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = { mode: target, resolve };
      this.modeWaiter = waiter;
      this.modeTimer = this.timers.setTimeout(() => {
        if (this.modeWaiter !== waiter) return;
        this.modeWaiter = null;
        reject(new ApiError("INTERNAL"));
      }, MODE_UPDATED_TIMEOUT_MS);
      this.options.client
        .request({ type: "room:update", mode: target })
        .catch((error: unknown) => {
          if (this.modeWaiter !== waiter) return;
          this.modeWaiter = null;
          this.timers.clearTimeout(this.modeTimer);
          reject(error);
        });
    });
  }

  /** 依目前狀態建立 host transport，接上信令轉送與狀態／錯誤回呼。 */
  protected build(gen: number): HostTransport {
    const current = () =>
      gen === this.generation && !this.destroyed && !this.closed;
    const signal: TransportSignal = {
      sendSignal: (to, data) =>
        current() && this.options.client.send({ type: "signal", to, data }),
      onSignal: (handler) => {
        if (current()) this.signalHandler = handler;
        return () => {
          if (this.signalHandler === handler) this.signalHandler = null;
        };
      },
      onPeerRequest: (handler) => {
        if (current()) this.peerHandler = handler;
        return () => {
          if (this.peerHandler === handler) this.peerHandler = null;
        };
      },
    };
    const transport = this.createTransport({
      stream: this.source.stream!,
      signal,
      mode: this.mode,
      quality: this.quality,
      roomId: this.options.roomId,
      token: this.options.token,
    });
    transport.onError((error) => {
      // 個別收看者的連線失敗由傳輸自己 removePeer；只顯示畫質套用失敗。
      if (current() && error.code === "TRACK_ERROR") this.showError(error);
    });
    transport.onState((state) => {
      if (state !== "error" || !current()) return;
      if (this.op !== "starting") this.failLive();
      // 傳輸已就緒、等開播確認時失敗：撤回這次開播。start() 還沒完成時交給它的 reject。
      else if (this.readyGeneration === gen) this.failLive(true);
    });
    return transport;
  }
}
