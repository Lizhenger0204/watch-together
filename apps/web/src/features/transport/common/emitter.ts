/** 取消訂閱函式。 */
export type Unsubscribe = () => void;

/**
 * 型別安全的事件發射器。
 * `Events` 把事件名稱對應到「引數 tuple」，例如
 * `{ state: [HostTransportState]; peerState: [{ memberId: string; state: MemberState }] }`。
 */
export class Emitter<Events extends Record<string, unknown[]>> {
  private listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<Event extends keyof Events>(
    event: Event,
    handler: (...args: Events[Event]) => void,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const stored = handler as unknown as (...args: never[]) => void;
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }

  emit<Event extends keyof Events>(event: Event, ...args: Events[Event]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as unknown as (...args: Events[Event]) => void)(...args);
    }
  }

  /** 移除所有監聽（destroy 時呼叫）。 */
  removeAll(): void {
    this.listeners.clear();
  }
}
