/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型：分頁間信令、DataChannel 分塊格式、對時。不是正式程式碼。

export const CHUNK_BYTES = 64 * 1024;
export const HEADER_BYTES = 16;
export const KIND_INIT = 1;
export const KIND_MEDIA = 2;
export const TRACK_VIDEO = 0;
export const TRACK_AUDIO = 1;

/** 房主時鐘：epoch 毫秒（高精度），雙方用同一種定義。 */
export function nowMs() {
  return performance.timeOrigin + performance.now();
}

/** 同源分頁間的信令（原型用 BroadcastChannel 代替 WebSocket）。 */
export function signalBus(onMessage) {
  const bc = new BroadcastChannel("t140-lab");
  bc.onmessage = (e) => onMessage(e.data);
  return (msg) => bc.postMessage(msg);
}

/**
 * 一個片段切成多個 DataChannel 訊息，每塊前面 16 bytes 標頭：
 * kind u8 | track u8 | last u8 | 0 u8 | epoch u32 | seq u32 | index u16 | count u16
 */
export function* chunkSegment(kind, track, epoch, seq, bytes, chunkBytes = CHUNK_BYTES) {
  const body = chunkBytes - HEADER_BYTES;
  const count = Math.max(1, Math.ceil(bytes.byteLength / body));
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(i * body, Math.min(bytes.byteLength, (i + 1) * body));
    const out = new Uint8Array(HEADER_BYTES + part.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, kind);
    dv.setUint8(1, track);
    dv.setUint8(2, i === count - 1 ? 1 : 0);
    dv.setUint32(4, epoch);
    dv.setUint32(8, seq);
    dv.setUint16(12, i);
    dv.setUint16(14, count);
    out.set(part, HEADER_BYTES);
    yield out;
  }
}

/** 依序重組（可靠、有序的 DataChannel，所以只需要依 seq 串接）。 */
export function reassembler(onSegment) {
  let parts = [];
  let key = "";
  return (buf) => {
    const u = new Uint8Array(buf);
    const dv = new DataView(u.buffer, u.byteOffset);
    const kind = dv.getUint8(0);
    const track = dv.getUint8(1);
    const last = dv.getUint8(2) === 1;
    const epoch = dv.getUint32(4);
    const seq = dv.getUint32(8);
    const k = `${kind}/${track}/${epoch}/${seq}`;
    // 房主跳轉時可能中途放棄一個片段：換了片段就丟掉沒收完的部分
    if (k !== key || dv.getUint16(12) === 0) parts = [];
    key = k;
    parts.push(u.subarray(HEADER_BYTES));
    if (!last) return;
    let n = 0;
    for (const p of parts) n += p.byteLength;
    const bytes = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      bytes.set(p, o);
      o += p.byteLength;
    }
    parts = [];
    onSegment({ kind, track, epoch, seq, bytes });
  };
}

/**
 * 類 NTP 對時：收看端送 t0，房主回 t1，收看端收到時 t2。
 * offset = t1 − (t0 + t2) / 2，取最近 N 筆裡 RTT 最小的一筆（RTT 小的樣本誤差上限 = RTT/2）。
 */
export function clockEstimator(keep = 16) {
  const samples = [];
  return {
    add(t0, t1, t2) {
      samples.push({ rtt: t2 - t0, offset: t1 - (t0 + t2) / 2 });
      if (samples.length > keep) samples.shift();
    },
    get best() {
      if (samples.length === 0) return null;
      return samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    },
    get count() {
      return samples.length;
    },
  };
}

/**
 * 依房主最後一次廣播推算「此刻應在的媒體時間」。
 * state = { playing, mediaTime, hostClock, rate }，hostNow = 收看端 nowMs() + offset。
 */
export function expectedMediaTime(state, hostNow) {
  if (!state.playing) return state.mediaTime;
  return state.mediaTime + ((hostNow - state.hostClock) / 1000) * state.rate;
}

/**
 * 追趕規則（ADR 0007 D2 的建議值，原型量測用）。drift = 收看端 − 應在時間（正值＝收看端超前），單位秒。
 * - |drift| ≤ dead（15 ms）：不動，playbackRate = 1
 * - 落後 ≥ behindSeek（300 ms）：跳到「應在時間 + 學到的跳轉耗時」
 * - 超前 ≥ aheadSeek（3 s）：跳轉；超前 ≥ hold（80 ms）：暫停 drift 秒等主時鐘
 * - 其他：依差距調 playbackRate，上限 ±maxAdj（5%）
 */
export function catchUp(drift, opts = {}) {
  const dead = opts.dead ?? 0.015;
  const behindSeek = opts.behindSeek ?? 0.3;
  const aheadSeek = opts.aheadSeek ?? 3;
  const hold = opts.hold ?? 0.08;
  const maxAdj = opts.maxAdj ?? 0.05;
  const gain = opts.gain ?? 0.5;
  if (drift <= -behindSeek || drift >= aheadSeek) return { action: "seek" };
  if (drift >= hold) return { action: "hold", ms: drift * 1000 };
  const a = Math.abs(drift);
  if (a <= dead) return { action: "rate", rate: 1 };
  const adj = Math.min(maxAdj, a * gain);
  return { action: "rate", rate: drift > 0 ? 1 - adj : 1 + adj };
}
