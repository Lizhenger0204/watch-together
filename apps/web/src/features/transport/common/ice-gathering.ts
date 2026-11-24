/** close() 本身不保證發出原生事件，由 adapter 同步通知等待中的 HTTP offer。 */
export function waitForIceGathering(
  peer: EventTarget & Pick<RTCPeerConnection, "iceGatheringState">,
  closed: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (closed.aborted) return Promise.reject(closed.reason);
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      closed.removeEventListener("abort", finish);
      if (closed.aborted) reject(closed.reason);
      else resolve();
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onStateChange);
    closed.addEventListener("abort", finish);
  });
}
