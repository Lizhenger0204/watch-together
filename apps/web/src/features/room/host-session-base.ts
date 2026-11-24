import type { Mode, Quality } from "@project/shared";
import { ApiError } from "../../lib/api";
import {
  type CreateHostTransport,
  type HostTransport,
  type TransportSignal,
} from "../transport";
import { streamTitle } from "./live-intent";
import type { HostSessionOptions, HostSource, Op } from "./host-session-types";
import type { SessionTimers } from "./viewer-session";

/** 切模式第 2 步：等 `room:updated` 廣播的期限（§6）。 */
export const MODE_UPDATED_TIMEOUT_MS = 10_000;

/**
 * HostSession 的抽象基類，把兩個「送出請求／建立傳輸」的功能抽出來：
 * - confirmStop／confirmMode／updateTitle：送 stream:status／room:update，等 ack 或廣播，
 *   含逾時與到期語意。
 * - build：依目前狀態建立 host transport 並接上信令與狀態回呼。
 * 這些方法會改動 session 狀態，因此狀態欄位宣告為 abstract，由 HostSession 提供。
 */
export abstract class HostSessionBase {
  protected abstract source: HostSource;
  protected abstract generation: number;
  protected abstract serverLive: boolean;
  protected abstract serverTitle: string | null;
  protected abstract pendingTitle: string | null;
  protected abstract hasPendingTitle: boolean;
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
  protected abstract signalHandler:
    Parameters<TransportSignal["onSignal"]>[0] | null;
  protected abstract peerHandler:
    Parameters<TransportSignal["onPeerRequest"]>[0] | null;
  protected abstract createTransport: CreateHostTransport;

  protected abstract publish(): void;
  protected abstract showError(error: unknown): void;
  protected abstract failLive(): void;

  /** 送停播；同一 reqId 的 ack 或之後的 live:false 廣播先到者為確認。 */
  protected confirmStop(): Promise<void> {
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
            this.serverLive = false;
            this.serverTitle = null;
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

  /**
   * 送出目前片名。已送過同一個、或伺服器已是同一個且沒有未確認的變更，就不重送。
   * `pendingTitle` 用 null 代表「沒有待送的片名」，但 null 本身也是合法片名（空白片名），
   * 所以另外用 `hasPendingTitle` 區分「有 null 待送」和「沒有待送」。
   */
  protected updateTitle(): void {
    const title = streamTitle(this.source.title);
    if (this.hasPendingTitle && title === this.pendingTitle) return;
    if (!this.hasPendingTitle && title === this.serverTitle) return;
    const gen = this.generation;
    this.pendingTitle = title;
    this.hasPendingTitle = true;
    this.options.client
      .request({ type: "stream:status", live: true, title })
      .then(
        () => {
          if (gen !== this.generation || !this.hasPendingTitle) return;
          if (this.pendingTitle !== title) return;
          this.pendingTitle = null;
          this.hasPendingTitle = false;
          this.serverTitle = title;
          this.publish();
        },
        (error: unknown) => {
          if (gen !== this.generation || !this.hasPendingTitle) return;
          if (this.pendingTitle !== title) return;
          this.pendingTitle = null;
          this.hasPendingTitle = false;
          this.showError(error);
        },
      );
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
      // 開播中的失敗由 start() 的 reject 處理。
      if (state === "error" && current() && this.op !== "starting") {
        this.failLive();
      }
    });
    return transport;
  }
}
