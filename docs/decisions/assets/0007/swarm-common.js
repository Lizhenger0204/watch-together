/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 種子式散布原型的共用部分：信令、分塊、雜湊、配速、送出佇列。不是正式程式碼。
import { box } from "./fmp4.js";

export const CHUNK = 64 * 1024;
export const HDR = 12; // u32 seg | u16 index | u16 count | u32 total
export const INIT_SEG = 0xffffffff;
export const nowMs = () => performance.timeOrigin + performance.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 分頁間信令（代替信令伺服器）。`to` 不是自己的訊息一律忽略。 */
export function bus(me, onMessage) {
  const bc = new BroadcastChannel("t140-swarm");
  bc.onmessage = (e) => {
    if (e.data.to === me || e.data.to === "*") onMessage(e.data);
  };
  return (to, msg) => bc.postMessage({ ...msg, from: me, to });
}

export async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 依序重組：同一條頻道一次只送一個片段的所有塊。 */
export function reassembler(onSegment) {
  let parts = [];
  let cur = -1;
  return (buf) => {
    const dv = new DataView(buf);
    const seg = dv.getUint32(0);
    const idx = dv.getUint16(4);
    const count = dv.getUint16(6);
    if (seg !== cur || idx === 0) parts = [];
    cur = seg;
    parts.push(new Uint8Array(buf, HDR));
    if (idx !== count - 1) return;
    const total = dv.getUint32(8);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.byteLength));
    parts = [];
    cur = -1;
    onSegment(seg, out);
  };
}

/** 總量配速（token bucket 的虛擬時間版）：所有頻道共用一個。 */
export function pacer(bps) {
  let vt = 0;
  return {
    bps,
    async take(bytes) {
      const now = performance.now();
      vt = Math.max(vt, now - 50) + ((bytes * 8) / this.bps) * 1000;
      if (vt - now > 15) await sleep(vt - now);
    },
  };
}

/**
 * 一條資料頻道的送出佇列：依優先值（片段開始時間，越早越急）挑下一個片段，整段送完才換下一段。
 * onSent(seg, bytes, tag) 用來記帳；isStale(seg) 為真的片段直接丟掉。
 */
export function sender(dc, pace, onSent, isStale = () => false) {
  const q = [];
  let busy = false;
  dc.bufferedAmountLowThreshold = 256 << 10;
  async function run() {
    if (busy) return;
    busy = true;
    try {
      while (q.length && dc.readyState === "open") {
        q.sort((a, b) => a.prio - b.prio);
        const job = q.shift();
        if (job.seg !== INIT_SEG && isStale(job.seg)) continue; // 已經播過的片段不送（大片段時尤其重要）
        const bytes = job.mutate ? job.mutate(job.bytes) : job.bytes;
        const body = CHUNK - HDR;
        const count = Math.max(1, Math.ceil(bytes.byteLength / body));
        for (let i = 0; i < count; i++) {
          const part = bytes.subarray(i * body, Math.min(bytes.byteLength, (i + 1) * body));
          const out = new Uint8Array(HDR + part.byteLength);
          const v = new DataView(out.buffer);
          v.setUint32(0, job.seg);
          v.setUint16(4, i);
          v.setUint16(6, count);
          v.setUint32(8, bytes.byteLength);
          out.set(part, HDR);
          await pace.take(out.byteLength);
          while (dc.bufferedAmount > 1 << 20) await new Promise((r) => dc.addEventListener("bufferedamountlow", r, { once: true }));
          if (dc.readyState !== "open") return;
          dc.send(out);
        }
        onSent?.(job.seg, bytes.byteLength, job.tag);
      }
    } catch (e) {
      console.error("sender", e);
    } finally {
      busy = false;
    }
  }
  dc.addEventListener("open", run);
  setInterval(() => q.length && run(), 500); // 頻道晚開、或上一輪中斷時重新啟動
  return {
    push(seg, bytes, prio, tag, mutate) {
      if (!q.some((j) => j.seg === seg)) q.push({ seg, bytes, prio, tag, mutate });
      run();
    },
    get queued() {
      return q.length;
    },
  };
}

/** 讀 box 清單（只看最上層或某個 box 的直接子層）。 */
function boxes(u8, start = 0, end = u8.byteLength) {
  const out = [];
  const dv = new DataView(u8.buffer, u8.byteOffset);
  for (let o = start; o + 8 <= end; ) {
    const size = dv.getUint32(o);
    const type = String.fromCharCode(...u8.subarray(o + 4, o + 8));
    out.push({ type, start: o, end: o + size, body: u8.subarray(o + 8, o + size) });
    o += size;
  }
  return out;
}

/** 兩個單軌 init（fmp4.js）合成一個影音 init：ftyp + moov(mvhd, trak×2, mvex(trex×2))。 */
export function muxedInit(vInit, aInit) {
  if (!aInit) return vInit;
  const [vf, vm] = boxes(vInit);
  const [, am] = boxes(aInit);
  const vc = boxes(vm.body);
  const ac = boxes(am.body);
  const get = (list, t) => list.find((b) => b.type === t);
  const trex = (list) => boxes(get(list, "mvex").body)[0];
  const raw = (b, src) => src.subarray(b.start, b.end);
  const vBody = vm.body;
  const aBody = am.body;
  return concatU8([
    raw(vf, vInit),
    box(
      "moov",
      raw(get(vc, "mvhd"), vBody),
      raw(get(vc, "trak"), vBody),
      raw(get(ac, "trak"), aBody),
      box("mvex", raw(trex(vc), get(vc, "mvex").body), raw(trex(ac), get(ac, "mvex").body)),
    ),
  ]);
}

export function concatU8(parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.byteLength));
  return out;
}

export function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
