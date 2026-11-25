import type { Mode } from "@project/shared";
import type { HostTransport } from "../transport";
import { HostSessionBase } from "./host-session-base";
import {
  disconnected,
  readable,
  tracksOf,
  type Tracks,
} from "./host-session-types";
import { streamTitle } from "./live-intent";

/**
 * HostSession 的開播、停播與直播中切模式流程（streaming.md §6「房主」1～4 步）。
 * 每個流程開始時記下 generation，await 之後比對，過時就不再改狀態。
 * 狀態欄位與協調（reconcile）由 HostSession 提供。
 */
export abstract class HostSessionFlows extends HostSessionBase {
  protected abstract intent: boolean;
  protected abstract transport: HostTransport | null;
  protected abstract applied: Tracks;
  protected abstract error: string | null;

  protected abstract reconcile(): void;
  protected abstract dropTransport(): void;
  protected abstract cancelIntent(): void;
  protected abstract sourceReady(): boolean;

  protected async startLive() {
    const gen = ++this.generation;
    this.op = "starting";
    this.publish();

    let transport: HostTransport;
    try {
      transport = this.build(gen);
    } catch (error) {
      this.failStart(error);
      return;
    }
    this.transport = transport;
    this.applied = tracksOf(this.source.stream);

    try {
      await transport.start();
    } catch (error) {
      if (gen !== this.generation) return;
      if (disconnected(error)) {
        // 不是傳輸本身失敗，是連線中斷：保留意圖，重新驗證（snapshot）後重建。
        this.dropTransport();
        this.op = null;
        this.publish();
        return;
      }
      this.failStart(error);
      return;
    }
    if (gen !== this.generation) return;
    // 之後傳輸失敗由 build() 的狀態回呼撤回開播；拆掉傳輸會換世代，晚到的 ack 不再生效。
    this.readyGeneration = gen;
    // start() 期間停止意圖、片源換掉或模式被改：這個傳輸已過時，拆掉交給 reconcile 收尾。
    if (!this.intent || !this.sourceReady() || transport.mode !== this.mode) {
      this.op = null;
      if (!this.sourceReady() || transport.mode !== this.mode) {
        this.dropTransport();
      }
      this.reconcile();
      this.publish();
      return;
    }

    // 上一次停播尚未確認（live:false 逾時或傳輸失敗）時，serverLive 仍可能為 true。
    // 先確認停播，伺服器才會在收 live:true 時走 false→true 並對收看者重發 peer:request。
    if (this.serverLive) {
      try {
        await this.confirmStop();
      } catch (error) {
        if (gen !== this.generation) return;
        if (disconnected(error)) {
          this.dropTransport();
          this.op = null;
          this.publish();
          return;
        }
        this.failStart(error);
        return;
      }
      if (gen !== this.generation) return;
      // 等停播確認期間，房主可能撤回開播、換成待確認的片源，或模式被改：重新判斷再開播。
      if (!this.intent || !this.sourceReady() || transport.mode !== this.mode) {
        this.op = null;
        this.dropTransport();
        this.reconcile();
        this.publish();
        return;
      }
    }

    const title = streamTitle(this.source.title);
    try {
      this.liveSends += 1;
      await this.options.client.request({
        type: "stream:status",
        live: true,
        title,
      });
    } catch (error) {
      if (gen !== this.generation) return;
      if (disconnected(error)) {
        // 不是伺服器拒絕：保留意圖，重新驗證（snapshot）後重建。
        this.dropTransport();
        this.op = null;
        this.publish();
        return;
      }
      this.failStart(error);
      return;
    }
    if (gen !== this.generation) return;
    this.serverLive = true;
    this.titles.server = title;
    this.op = null;
    this.reconcile();
    this.publish();
  }

  /** 開播失敗：拆掉傳輸、取消意圖並顯示錯誤；再按「開始直播」就是重試。 */
  protected failStart(error: unknown) {
    this.dropTransport();
    this.op = null;
    this.cancelIntent();
    this.error = `無法開始直播：${readable(error)}`;
    this.publish();
  }

  protected async stopLive() {
    if (!this.serverLive) {
      this.dropTransport();
      this.reconcile();
      this.publish();
      return;
    }
    const gen = this.generation;
    this.op = "stopping";
    this.publish();
    try {
      await this.confirmStop();
    } catch (error) {
      if (gen !== this.generation) return;
      this.dropTransport();
      this.op = null;
      if (!disconnected(error)) this.error = readable(error);
      this.publish();
      return;
    }
    if (gen !== this.generation) return;
    this.transport?.stop();
    this.dropTransport();
    this.op = null;
    this.reconcile();
    this.publish();
  }

  /**
   * §6「房主」1～4 步。`sendUpdate` 為 false 表示伺服器的模式已經是 target
   * （開播途中被改），只需要停播、重建。
   */
  protected async switchMode(target: Mode, sendUpdate: boolean) {
    const gen = this.generation;
    this.op = "switching";
    this.publish();

    // 1. 停播，等同一 reqId 的 ack 或本次之後的停播廣播。失敗或逾時就停在這一步。
    try {
      await this.confirmStop();
    } catch (error) {
      if (gen !== this.generation) return;
      this.op = null;
      if (!this.intent) {
        // 切換途中房主已經按停止：不等重送的停播確認，立刻停掉本機出流。
        // 伺服器停播仍待確認（serverLive 還是 true），stopLive 會在沒有傳輸時照樣重送 live:false。
        this.transport?.stop();
        this.dropTransport();
        void this.stopLive();
        return;
      }
      if (!disconnected(error)) {
        this.error = `切換失敗，仍維持原本的傳送方式：${readable(error)}`;
      }
      // 重新讀取意圖：切換途中可能已經按停止，要繼續走停播。
      this.reconcile();
      this.publish();
      return;
    }
    if (gen !== this.generation) return;

    // 2. 停止舊傳輸，再送 room:update；收到目標模式的 room:updated 後才 destroy。
    this.transport?.stop();
    if (sendUpdate) {
      try {
        await this.confirmMode(target);
      } catch (error) {
        if (gen !== this.generation) return;
        this.dropTransport();
        this.op = null;
        if (!disconnected(error)) {
          this.error = `切換傳送方式失敗：${readable(error)}`;
        }
        // 伺服器仍是舊模式：依意圖用舊模式重新開播。
        this.reconcile();
        this.publish();
        return;
      }
      if (gen !== this.generation) return;
    }
    this.dropTransport();
    this.op = null;

    // 3、4. 以最新片源、目前畫質與新模式重建，start() 後才送 live:true。
    this.reconcile();
    this.publish();
  }
}
