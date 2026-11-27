/* eslint-disable -- T-140 實驗原型 */
// ---- H.264 Annex B：解析 slice header 取得每張畫面的基本 QP（26 + pic_init_qp_minus26 + slice_qp_delta）----
class Bits {
  constructor(u) {
    this.u = u;
    this.p = 0;
  }
  bit() {
    if (this.end) throw new RangeError("H.264 slice header ended early");
    const b = (this.u[this.p >> 3] >> (7 - (this.p & 7))) & 1;
    this.p++;
    return b;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue() {
    let z = 0;
    while (this.bit() === 0 && z < 32) z++;
    return z ? 2 ** z - 1 + this.bits(z) : 0;
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
  get end() {
    return this.p >= this.u.length * 8;
  }
}
function rbsp(n) {
  const o = new Uint8Array(n.length);
  let k = 0,
    z = 0;
  for (const b of n) {
    if (z >= 2 && b === 3) {
      z = 0;
      continue;
    }
    o[k++] = b;
    z = b === 0 ? z + 1 : 0;
  }
  return o.subarray(0, k);
}
function* nals(u) {
  let i = 0,
    s = -1;
  while (i + 2 < u.length) {
    if (u[i] === 0 && u[i + 1] === 0 && u[i + 2] === 1) {
      if (s >= 0) yield u.subarray(s, i > 0 && u[i - 1] === 0 ? i - 1 : i);
      i += 3;
      s = i;
    } else i++;
  }
  if (s >= 0) yield u.subarray(s);
}
const HIGH = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
function sps(r, SPS) {
  const b = new Bits(r);
  b.bits(8);
  const prof = b.bits(8);
  b.bits(16);
  const id = b.ue();
  const s = { ch: 1, sep: 0 };
  if (HIGH.includes(prof)) {
    s.ch = b.ue();
    if (s.ch === 3) s.sep = b.bit();
    b.ue();
    b.ue();
    b.bit();
    if (b.bit())
      for (let i = 0; i < (s.ch !== 3 ? 8 : 12); i++)
        if (b.bit()) {
          let last = 8,
            next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next) next = (last + b.se() + 256) % 256;
            last = next || last;
          }
        }
  }
  s.fn = b.ue() + 4;
  s.poc = b.ue();
  if (s.poc === 0) s.pocBits = b.ue() + 4;
  else if (s.poc === 1) {
    s.az = b.bit();
    b.se();
    b.se();
    const n = b.ue();
    for (let i = 0; i < n; i++) b.se();
  }
  b.ue();
  b.bit();
  b.ue();
  b.ue();
  s.fmo = b.bit();
  SPS[id] = s;
}
function pps(r, PPS) {
  const b = new Bits(r);
  b.bits(8);
  const id = b.ue();
  const p = { sps: b.ue() };
  p.cabac = b.bit();
  p.bf = b.bit();
  p.bad = b.ue() > 0;
  p.l0 = b.ue();
  p.l1 = b.ue();
  p.wp = b.bit();
  p.wb = b.bits(2);
  p.qp = 26 + b.se();
  b.se();
  b.se();
  b.bit();
  b.bit();
  p.rpc = b.bit();
  PPS[id] = p;
}
function sliceQp(r, type, ref, SPS, PPS) {
  const b = new Bits(r);
  b.bits(8);
  b.ue();
  const st = b.ue() % 5;
  const p = PPS[b.ue()];
  if (!p || p.bad) return null;
  const s = SPS[p.sps];
  if (!s) return null;
  if (s.sep) b.bits(2);
  b.bits(s.fn);
  let field = 0;
  if (!s.fmo) {
    field = b.bit();
    if (field) b.bit();
  }
  if (type === 5) b.ue();
  if (s.poc === 0) {
    b.bits(s.pocBits);
    if (p.bf && !field) b.se();
  } else if (s.poc === 1 && !s.az) {
    b.se();
    if (p.bf && !field) b.se();
  }
  if (p.rpc) b.ue();
  const B = st === 1,
    P = st === 0 || st === 3;
  if (B) b.bit();
  let l0 = p.l0,
    l1 = p.l1;
  if ((P || B) && b.bit()) {
    l0 = b.ue();
    if (B) l1 = b.ue();
  }
  if (st !== 2 && st !== 4)
    for (let k = 0; k < (B ? 2 : 1); k++)
      if (b.bit()) {
        let idc;
        do {
          idc = b.ue();
          if (idc < 3) b.ue();
        } while (idc !== 3 && !b.end);
      }
  if ((p.wp && P) || (p.wb === 1 && B)) {
    b.ue();
    const ch = s.ch !== 0 && !s.sep;
    if (ch) b.ue();
    for (const n of B ? [l0, l1] : [l0])
      for (let i = 0; i <= n; i++) {
        if (b.bit()) {
          b.se();
          b.se();
        }
        if (ch && b.bit()) {
          b.se();
          b.se();
          b.se();
          b.se();
        }
      }
  }
  if (ref) {
    if (type === 5) {
      b.bit();
      b.bit();
    } else if (b.bit()) {
      let m;
      do {
        m = b.ue();
        if (m === 1 || m === 3 || m === 2 || m === 6 || m === 4) b.ue();
        if (m === 3) b.ue();
      } while (m !== 0 && !b.end);
    }
  }
  if (p.cabac && st !== 2 && st !== 4) b.ue();
  return p.qp + b.se();
}
function createQpReader() {
  const SPS = Object.create(null),
    PPS = Object.create(null);
  return (data) => {
    let qp = null;
    try {
      for (const n of nals(data)) {
        const t = n[0] & 31;
        if (t === 7) sps(rbsp(n), SPS);
        else if (t === 8) pps(rbsp(n), PPS);
        else if (t === 1 || t === 5)
          qp = sliceQp(rbsp(n), t, (n[0] >> 5) & 3, SPS, PPS);
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return null;
    }
    return Number.isInteger(qp) && qp >= 0 && qp <= 51 ? qp : null;
  };
}
