/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型：最小 fMP4 封裝器（不是正式程式碼）。
// 每條軌各自一份 init segment（給各自的 SourceBuffer），媒體片段 = moof + mdat。
// 時間戳保持原片的絕對時間（tfdt），收看端 currentTime 就等於房主 <video> 的媒體時間。

const te = new TextEncoder();

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function u8(v) {
  return Uint8Array.of(v & 0xff);
}
function u16(v) {
  return Uint8Array.of((v >>> 8) & 0xff, v & 0xff);
}
function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
function i32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v | 0);
  return b;
}
function u64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.max(0, Math.round(v))));
  return b;
}
function zeros(n) {
  return new Uint8Array(n);
}

export function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32(body.byteLength + 8), te.encode(type), body]);
}
function fullBox(type, version, flags, ...payload) {
  return box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...payload);
}

const MATRIX = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

function descriptor(tag, body) {
  // MPEG-4 descriptor：長度用 4 bytes 的可變長度格式，避免長度計算出錯。
  const n = body.byteLength;
  return concat([
    u8(tag),
    Uint8Array.of(0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f),
    body,
  ]);
}

function sampleEntry(t) {
  if (t.kind === "video") {
    const child = box(t.configBox, toU8(t.description));
    return box(
      t.sampleEntry,
      zeros(6),
      u16(1),
      u16(0),
      u16(0),
      zeros(12),
      u16(t.width),
      u16(t.height),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      zeros(32),
      u16(0x0018),
      u16(0xffff),
      child,
    );
  }
  const asc = toU8(t.description);
  const dsi = descriptor(5, asc);
  const dcd = descriptor(4, concat([u8(0x40), u8(0x15), Uint8Array.of(0, 0, 0), u32(0), u32(0), dsi]));
  const es = descriptor(3, concat([u16(t.trackId), u8(0), dcd, descriptor(6, u8(2))]));
  const esds = fullBox("esds", 0, 0, es);
  return box(
    "mp4a",
    zeros(6),
    u16(1),
    zeros(8),
    u16(t.channels),
    u16(16),
    u16(0),
    u16(0),
    u32(t.sampleRate << 16),
    esds,
  );
}

function toU8(d) {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d);
}

/**
 * @param {{kind:'video'|'audio', trackId:number, timescale:number, sampleEntry:string, configBox?:string,
 *   description:BufferSource, width?:number, height?:number, channels?:number, sampleRate?:number}} t
 */
export function initSegment(t) {
  const isVideo = t.kind === "video";
  const ftyp = box("ftyp", te.encode("isom"), u32(0x200), te.encode("isomiso6mp41"));
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(0),
    u32(0x00010000),
    u16(0x0100),
    zeros(10),
    MATRIX,
    zeros(24),
    u32(t.trackId + 1),
  );
  const tkhd = fullBox(
    "tkhd",
    0,
    3,
    u32(0),
    u32(0),
    u32(t.trackId),
    u32(0),
    u32(0),
    zeros(8),
    u16(0),
    u16(0),
    u16(isVideo ? 0 : 0x0100),
    u16(0),
    MATRIX,
    u32((t.width ?? 0) << 16),
    u32((t.height ?? 0) << 16),
  );
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    te.encode(isVideo ? "vide" : "soun"),
    zeros(12),
    u8(0),
  );
  const mhd = isVideo ? fullBox("vmhd", 0, 1, zeros(8)) : fullBox("smhd", 0, 0, zeros(4));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), sampleEntry(t)),
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)),
  );
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", mhd, dinf, stbl)));
  const mvex = box("mvex", fullBox("trex", 0, 0, u32(t.trackId), u32(1), u32(0), u32(0), u32(0)));
  return concat([ftyp, box("moov", mvhd, trak, mvex)]);
}

/**
 * 媒體片段。samples 依解碼順序排列，pts 以秒計（mediabunny 的 packet.timestamp）。
 * DTS 取「本片段 PTS 排序後的序列」，PTS − DTS 寫成 trun v1 的有號 composition offset。
 * @param {{trackId:number, timescale:number, seq:number,
 *   samples:{pts:number, duration:number, key:boolean, data:Uint8Array}[]}} f
 */
export function mediaSegment(f) {
  const ts = f.timescale;
  const pts = f.samples.map((s) => Math.round(s.pts * ts));
  const dts = [...pts].sort((a, b) => a - b);
  const n = f.samples.length;
  const entries = [];
  for (let i = 0; i < n; i++) {
    const s = f.samples[i];
    const dur = i + 1 < n ? dts[i + 1] - dts[i] : Math.max(1, Math.round(s.duration * ts));
    const flags = s.key ? 0x02000000 : 0x01010000;
    entries.push(u32(dur), u32(s.data.byteLength), u32(flags), i32(pts[i] - dts[i]));
  }
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const build = (dataOffset) =>
    box(
      "moof",
      fullBox("mfhd", 0, 0, u32(f.seq)),
      box(
        "traf",
        fullBox("tfhd", 0, 0x020000, u32(f.trackId)),
        fullBox("tfdt", 1, 0, u64(dts[0])),
        fullBox("trun", 1, trunFlags, u32(n), i32(dataOffset), ...entries),
      ),
    );
  const moofSize = build(0).byteLength;
  const moof = build(moofSize + 8);
  const mdat = box("mdat", ...f.samples.map((s) => s.data));
  return concat([moof, mdat]);
}

/** mediabunny 的 decoderConfig → 這個封裝器要的軌道描述。 */
export function describeTrack(kind, cfg, trackId) {
  if (kind === "video") {
    const c = cfg.codec;
    const isHevc = c.startsWith("hvc1") || c.startsWith("hev1");
    return {
      kind,
      trackId,
      timescale: 90000,
      sampleEntry: isHevc ? (c.startsWith("hev1") ? "hev1" : "hvc1") : "avc1",
      configBox: isHevc ? "hvcC" : "avcC",
      description: cfg.description,
      width: cfg.codedWidth,
      height: cfg.codedHeight,
      mime: `video/mp4; codecs="${c}"`,
    };
  }
  return {
    kind,
    trackId,
    timescale: cfg.sampleRate,
    sampleEntry: "mp4a",
    description: cfg.description,
    channels: cfg.numberOfChannels,
    sampleRate: cfg.sampleRate,
    mime: `audio/mp4; codecs="${cfg.codec}"`,
  };
}
