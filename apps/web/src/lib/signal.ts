import {
  PROTOCOL_VERSION,
  WS_PING_INTERVAL_MS,
  parseServerMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@project/shared";
import { ApiError } from "./api";

// 房間 WebSocket 客戶端：連線後送 auth、心跳、依關閉碼決定是否重連、reqId ↔ ack 對應。
// 不依賴 React；WebSocket 與計時器可注入，方便測試。

export type CloseReason =
  | "replaced"
  | "room_closed"
  | "kicked"
  | "unauthorized"
  | "bad_request"
  | "stopped";

export type ConnectionState =
  | { status: "connecting" }
  | { status: "open" }
  | { status: "reconnecting"; attempt: number }
  | { status: "closed"; reason: CloseReason };

/** protocol.md「關閉碼」：這些情況不重連。 */
const FINAL_CLOSE: Record<number, CloseReason> = {
  4000: "replaced",
  4001: "room_closed",
  4003: "kicked",
  4400: "bad_request",
  4401: "unauthorized",
};

export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

export type SignalClientOptions = {
  url: string;
  token: string;
  createSocket?: (url: string) => SocketLike;
  timers?: Timers;
  random?: () => number;
  requestTimeoutMs?: number;
  /**
   * 用 REST 確認 token／房間還在。房間被刪掉後 WebSocket 握手直接失敗（瀏覽器只看到 1006），
   * 以及驗證前就收到 4400 時，靠它分辨「網路問題」和「身份已不存在」。
   */
  verifyIdentity?: () => Promise<IdentityCheck>;
};

export type IdentityCheck =
  "valid" | "room_closed" | "unauthorized" | "unknown";

/** 連續重連失敗（期間沒收到 room:snapshot）幾次後查一次身份；之後每隔同樣次數再查。 */
export const IDENTITY_CHECK_AFTER_ATTEMPTS = 5;

const OPEN = 1;
const MAX_BACKOFF_MS = 15_000;

/** 送出時不需要帶 reqId，由 request() 自動加上。 */
type Outgoing = Exclude<ClientMessage, { type: "auth" }>;
type Requestable = Extract<Outgoing, { reqId?: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * 連線中斷（尚未連上、或等待 ack 時 socket 被清掉）造成的請求失敗，不是伺服器拒絕。
 * 呼叫端應保留意圖，等重新連線、重新驗證後再送。
 */
export class SignalDisconnectedError extends ApiError {
  constructor() {
    super("INTERNAL");
    this.name = "SignalDisconnectedError";
  }
}

/**
 * 請求在期限內沒收到回應（ack 或預期的廣播）：伺服器可能已處理也可能沒處理，
 * 結果不明。呼叫端不可假設伺服器仍在原狀態，必要時以 resync() 重新同步。
 */
export class SignalTimeoutError extends ApiError {
  constructor() {
    super("INTERNAL");
    this.name = "SignalTimeoutError";
  }
}

export class SignalClient {
  private socket: SocketLike | null = null;
  private state: ConnectionState = { status: "connecting" };
  private attempt = 0;
  private started = false;
  private stopped = false;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private nextReqId = 1;
  /** 每次收到 room:snapshot 或主動 start()／resync() 加一；確認身份的結果回來時用來判斷是否已經過時。 */
  private session = 0;
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: unknown }
  >();
  private readonly messageHandlers = new Set<(m: ServerMessage) => void>();
  private readonly stateHandlers = new Set<(s: ConnectionState) => void>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: SignalClientOptions) {
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id as number),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id as number),
    };
    this.random = options.random ?? Math.random;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  get connection() {
    return this.state;
  }

  onMessage(handler: (message: ServerMessage) => void) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onState(handler: (state: ConnectionState) => void) {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  start() {
    if (this.started && !this.stopped && this.state.status !== "closed") return;
    this.started = true;
    this.stopped = false;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.teardown();
    socket?.close(1000, "restart");
    this.attempt = 0;
    this.session += 1;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.teardown();
    socket?.close(1000, "bye");
    this.setState({ status: "closed", reason: "stopped" });
  }

  /**
   * 關閉目前連線並立即開啟新連線重新驗證，以取得最新 room:snapshot。
   * 尚未 start()、已手動停止或因終止關閉碼結束時不做任何事。
   */
  resync() {
    if (!this.started || this.stopped || this.state.status === "closed") return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    // 先解除舊 socket 的事件與在途請求再關閉，避免同步觸發 onclose 誤排重連。
    this.teardown();
    socket?.close(1000, "resync");
    this.attempt = 0;
    // 讓先前的 verifyIdentity() 查詢過期，避免舊連線的 4400／重連查詢誤殺新連線。
    this.session += 1;
    this.open();
  }

  /** 不需要回應的訊息（signal、member:status、ping）。未連線時丟棄。 */
  send(message: Outgoing) {
    if (this.socket?.readyState === OPEN && this.state.status === "open") {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /** 需要 ack 的請求。失敗時以 ApiError（斷線為 SignalDisconnectedError、逾時為 SignalTimeoutError）拒絕。 */
  request(message: DistributiveOmit<Requestable, "reqId">): Promise<void> {
    const reqId = String(this.nextReqId++);
    return new Promise((resolve, reject) => {
      if (!this.send({ ...message, reqId } as Outgoing)) {
        reject(new SignalDisconnectedError());
        return;
      }
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(reqId);
        reject(new SignalTimeoutError());
      }, this.requestTimeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
    });
  }

  private open() {
    this.setState(
      this.attempt === 0
        ? { status: "connecting" }
        : { status: "reconnecting", attempt: this.attempt },
    );
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    let authenticated = false;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          token: this.options.token,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        console.warn("收到無法解析的伺服器訊息", parsed.error);
        return;
      }
      if (parsed.message.type === "room:snapshot") authenticated = true;
      this.handle(parsed.message);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.teardown();
      if (this.stopped) return;
      const reason = FINAL_CLOSE[event.code];
      // 驗證前的 4400 可能是本機 token 損壞，重新整理也沒用；先確認身份。
      if (reason === "bad_request" && !authenticated) {
        this.closeAfterVerify("bad_request");
        return;
      }
      if (reason) {
        this.setState({ status: "closed", reason });
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handle(message: ServerMessage) {
    if (message.type === "room:snapshot") {
      // 驗證成功才算連上；重連次數歸零。
      this.attempt = 0;
      this.session += 1;
      this.setState({ status: "open" });
      this.startPing();
    }
    if (message.type === "ack") {
      const entry = this.pending.get(message.reqId);
      if (entry) {
        this.pending.delete(message.reqId);
        this.timers.clearTimeout(entry.timer);
        if (message.ok) entry.resolve();
        else entry.reject(new ApiError(message.code));
      }
    }
    this.messageHandlers.forEach((handler) => handler(message));
  }

  private scheduleReconnect() {
    this.attempt += 1;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1));
    const delay = base / 2 + (base / 2) * this.random();
    this.setState({ status: "reconnecting", attempt: this.attempt });
    this.reconnectTimer = this.timers.setTimeout(() => this.open(), delay);
    if (this.attempt % IDENTITY_CHECK_AFTER_ATTEMPTS === 0) {
      this.closeAfterVerify(null);
    }
  }

  /** 確認身份：已不存在就以對應原因結束；否則以 fallback 結束（null 代表繼續重連）。 */
  private closeAfterVerify(fallback: CloseReason | null) {
    const verify = this.options.verifyIdentity;
    if (!verify) {
      if (fallback) this.setState({ status: "closed", reason: fallback });
      return;
    }
    const session = this.session;
    void verify()
      .catch((): IdentityCheck => "unknown")
      .then((result) => {
        if (this.stopped || this.session !== session) return;
        if (this.state.status === "closed") return;
        const reason =
          result === "room_closed" || result === "unauthorized"
            ? result
            : fallback;
        if (!reason) return;
        this.timers.clearTimeout(this.reconnectTimer);
        this.socket?.close(1000, "bye");
        this.teardown();
        this.setState({ status: "closed", reason });
      });
  }

  private startPing() {
    this.timers.clearInterval(this.pingTimer);
    this.pingTimer = this.timers.setInterval(
      () => this.send({ type: "ping" }),
      WS_PING_INTERVAL_MS,
    );
  }

  private teardown() {
    this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket = null;
    }
    for (const [, entry] of this.pending) {
      this.timers.clearTimeout(entry.timer);
      entry.reject(new SignalDisconnectedError());
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.stateHandlers.forEach((handler) => handler(state));
  }
}

export function signalUrl(roomId: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/rooms/${roomId}/ws`;
}

export type { ErrorCode };
