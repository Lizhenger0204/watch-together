/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 種子式散布原型：房主＝來源＋時鐘＋tracker（由房主協調）。
// 房主把每個片段只直送給一位收看者（輪流），並告訴其他人「向誰拿」；收看者回報持有清單，
// 房主據此替新加入、換來源的人指派；收看端驗證不過或逾時就向房主補拿。不是正式程式碼。
import { describeTrack, initSegment, mediaSegment } from "./fmp4.js";
import { INIT_SEG, bus, concatU8, muxedInit, nowMs, pacer, sender, sha256, sleep } from "./swarm-common.js";

const q = new URLSearchParams(location.search);
const MB_URL = q.get("mb") ?? "https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs";
const LEAD_S = Number(q.get("lead") ?? 20);
const BUDGET = Number(q.get("budget") ?? 77) * 1e6; // 房主總上傳預算
const COPIES = Number(q.get("copies") ?? 1); // 每個片段房主直送幾份（k）
const NO_SWARM = q.get("swarm") === "0"; // 對照組：每位收看者都由房主直送

const video = document.querySelector("video");
const log = (m) => (document.querySelector("#log").textContent += m + "\n");
const send = bus("host", onSignal);
const pace = pacer(BUDGET);
const links = new Map();
const cache = new Map(); // i → { bytes, sha }
const announced = new Set();
const m = { sent: { seed: 0, repair: 0, join: 0 }, perSec: [], events: [] };
let src = null;
let rr = 0;

async function open(url) {
  const blob = await (await fetch(url)).blob();
  const MB = await import(MB_URL);
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  const at = await input.getPrimaryAudioTrack();
  const v = describeTrack("video", await vt.getDecoderConfig(), 1);
  const a = at ? describeTrack("audio", await at.getDecoderConfig(), 2) : null;
  const vSink = new MB.EncodedPacketSink(vt);
  const aSink = at ? new MB.EncodedPacketSink(at) : null;
  // 片段表：以關鍵影格切（每段一個 GOP）。正式版另限 2 秒與大小（附錄 B §2）。
  const keys = [];
  for (let k = await vSink.getFirstPacket(); k; k = await vSink.getNextKeyPacket(k, { verifyKeyPackets: true })) keys.push(k);
  const duration = await input.computeDuration();
  const segs = keys.map((k, i) => ({ i, key: k, start: k.timestamp, end: keys[i + 1]?.timestamp ?? duration }));
  const init = muxedInit(initSegment(v), a ? initSegment(a) : null);
  src = { MB, v, a, vSink, aSink, segs, init, initSha: await sha256(init), bitrate: (blob.size * 8) / duration, duration };
  const target = Math.ceil(Math.max(...segs.map((s) => s.end - s.start)));
  src.playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    '#EXT-X-MAP:URI="init.mp4"',
    ...segs.flatMap((s) => [`#EXTINF:${(s.end - s.start).toFixed(6)},`, `seg/${s.i}.m4s`]),
    "#EXT-X-ENDLIST",
  ].join("\n");
  video.src = URL.createObjectURL(blob);
  await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  log(`source ${v.mime} ${a?.mime ?? "-"} ${segs.length} segs ${(src.bitrate / 1e6).toFixed(1)} Mbps`);
  return { segs: segs.length, mbps: +(src.bitrate / 1e6).toFixed(2), duration };
}

const segAt = (t) => {
  const s = src.segs;
  let lo = 0;
  for (let hi = s.length - 1; lo < hi; ) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].start <= t + 1e-6) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** 封裝第 i 段（影音同一個片段，兩組 moof/mdat）並算 SHA-256。 */
async function produce(i) {
  if (cache.has(i)) return cache.get(i);
  const s = src.segs[i];
  const vs = [];
  for await (const p of src.vSink.packets(s.key)) {
    if (vs.length && p.type === "key") break;
    vs.push({ pts: p.timestamp, duration: p.duration, key: p.type === "key", data: p.data });
  }
  const parts = [mediaSegment({ trackId: 1, timescale: src.v.timescale, seq: i * 2 + 1, samples: vs })];
  if (src.aSink) {
    const as = [];
    let p = (await src.aSink.getPacket(s.start)) ?? (await src.aSink.getFirstPacket());
    if (p && i > 0 && p.timestamp < s.start - 1e-6) p = await src.aSink.getNextPacket(p);
    for (; p && p.timestamp < s.end - 1e-6; p = await src.aSink.getNextPacket(p)) as.push({ pts: p.timestamp, duration: p.duration, key: true, data: p.data });
    if (as.length) parts.push(mediaSegment({ trackId: 2, timescale: src.a.timescale, seq: i * 2 + 2, samples: as }));
  }
  const bytes = concatU8(parts);
  const out = { bytes, sha: await sha256(bytes) };
  cache.set(i, out);
  return out;
}

let lastFrame = null;
function presented() {
  if (!video.paused && !video.seeking && lastFrame && performance.now() - lastFrame.p < 250) return lastFrame.m + ((performance.now() - lastFrame.p) / 1000) * video.playbackRate;
  return video.currentTime;
}
video.requestVideoFrameCallback(function f(_n, md) {
  lastFrame = { p: md.expectedDisplayTime, m: md.mediaTime };
  video.requestVideoFrameCallback(f);
});
const state = () => ({ type: "state", playing: !video.paused && !video.seeking && video.readyState >= 3, mediaTime: presented(), hostClock: nowMs(), rate: video.playbackRate });
const ready = () => [...links.values()].filter((l) => l.ready && l.ctl.readyState === "open");
function ctl(l, msg) {
  if (l.ctl.readyState === "open") l.ctl.send(JSON.stringify(msg));
}
function broadcast(msg) {
  for (const l of ready()) ctl(l, msg);
}
for (const ev of ["play", "pause", "playing", "waiting", "seeking", "seeked", "ratechange"]) video.addEventListener(ev, () => broadcast(state()));
setInterval(() => broadcast(state()), 1000);

/** 新片段：直送給 k 位（輪流挑可上傳、未被標記壞來源的人），其他人照指派向他們拿。 */
async function distribute(i) {
  const { bytes, sha } = await produce(i);
  const viewers = ready();
  if (!viewers.length) return;
  announced.add(i);
  const ups = viewers.filter((l) => l.upload && !l.bad);
  const seeds = new Set();
  const s = src.segs[i];
  // 急件（跳轉、剛開播：離播放位置不到 3 秒）房主直送給每個人，預讀才走種子
  if (NO_SWARM || !ups.length || s.start - presented() < 3) viewers.forEach((l) => seeds.add(l));
  else for (let c = 0; c < Math.min(COPIES, ups.length); c++) seeds.add(ups[rr++ % ups.length]);
  const seedList = [...seeds];
  for (const [n, l] of viewers.entries()) {
    const from = seeds.has(l) ? "host" : seedList[n % seedList.length].id;
    ctl(l, { type: "seg", i, sha, size: bytes.byteLength, start: s.start, from });
    if (from === "host" && !l.have.has(i)) l.out.push(i, bytes, s.start, "seed");
  }
}

/** 生產迴圈：房主播放位置往後 LEAD_S 秒內的片段依序散布。 */
async function producer() {
  for (;;) {
    await sleep(100);
    if (!src || !ready().length) continue;
    const t = presented();
    const from = segAt(Math.max(0, t - 0.5));
    const to = segAt(Math.min(src.duration - 0.01, t + LEAD_S));
    for (let i = from; i <= to; i++) if (!announced.has(i)) await distribute(i);
    for (const k of cache.keys()) if (src.segs[k].end < t - 30 || src.segs[k].start > t + LEAD_S + 10) cache.delete(k);
  }
}
video.addEventListener("seeking", () => {
  announced.clear(); // 新位置：重新散布（收看端已有的片段不會重複送，見 viewer 的 seg 處理）
  m.events.push({ type: "seek", at: nowMs(), to: video.currentTime });
});

/** 替某位收看者找第 i 段的來源：持有者中目前指派最少的；沒有就房主。 */
function pickHolder(i, except) {
  const holders = ready().filter((l) => l !== except && l.upload && !l.bad && l.have.has(i));
  holders.sort((a, b) => a.assigned - b.assigned);
  return holders[0] ?? null;
}
async function assign(l, i, tag) {
  const { bytes, sha } = await produce(i);
  const h = NO_SWARM ? null : pickHolder(i, l);
  if (h) h.assigned++;
  ctl(l, { type: "seg", i, sha, size: bytes.byteLength, start: src.segs[i].start, from: h ? h.id : "host" });
  if (!h) l.out.push(i, bytes, src.segs[i].start, tag);
}

async function onSignal(msg) {
  if (msg.type === "hello") return connect(msg.from, msg.upload);
  const l = links.get(msg.from);
  if (msg.type === "answer") await l?.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  if (msg.type === "ice" && msg.cand) await l?.pc.addIceCandidate(msg.cand);
}

async function connect(id, upload) {
  const pc = new RTCPeerConnection();
  const l = { id, pc, upload, ready: false, bad: false, have: new Set(), assigned: 0, sent: 0 };
  links.set(id, l);
  pc.onicecandidate = (e) => send(id, { type: "ice", cand: e.candidate?.toJSON() ?? null });
  l.ctl = pc.createDataChannel("pt-ctl");
  l.data = pc.createDataChannel("pt-data");
  l.out = sender(l.data, pace, (_seg, n, tag) => {
    m.sent[tag] = (m.sent[tag] ?? 0) + n;
    l.sent += n;
  }, (i) => src.segs[i].end < presented() - 1);
  l.ctl.onmessage = (e) => onCtl(l, JSON.parse(e.data));
  l.ctl.onclose = () => leave(l);
  l.ctl.onopen = () => ctl(l, { type: "manifest", playlist: src.playlist, initSha: src.initSha, segs: src.segs.map((s) => [s.start, s.end]) });
  await pc.setLocalDescription(await pc.createOffer());
  send(id, { type: "offer", sdp: pc.localDescription.sdp });
}

function leave(l) {
  if (!links.has(l.id)) return;
  links.delete(l.id);
  m.events.push({ type: "leave", id: l.id, at: nowMs() });
  send("*", { type: "unpair", peer: l.id }); // 正式版由伺服器撤銷配對（附錄 D §5）
}

async function onCtl(l, msg) {
  if (msg.type === "ready") {
    l.ready = true;
    l.joinedAt = nowMs();
    l.out.push(INIT_SEG, src.init, -1, "join");
    ctl(l, state());
    // 配對：新成員與現有可上傳者互連（正式版：房主向伺服器登記配對，伺服器才放行收看者之間的信令）
    for (const o of ready()) if (o !== l && !NO_SWARM) send("*", { type: "pair", a: l.id, b: o.id });
    // 已散布過、還在視窗內的片段：指派給持有者
    const t = presented();
    for (let i = segAt(Math.max(0, t - 0.5)); i <= segAt(Math.min(src.duration - 0.01, t + LEAD_S)); i++) if (announced.has(i)) await assign(l, i, "join");
  }
  if (msg.type === "have") l.have = new Set(msg.have);
  if (msg.type === "req") {
    // 收看端向房主補拿（逾時、驗證失敗、來源離開）
    const { bytes } = await produce(msg.i);
    l.out.push(msg.i, bytes, src.segs[msg.i].start, "repair");
  }
  if (msg.type === "where") await assign(l, msg.i, "repair");
  // 播放器要的片段：還沒散布就照常散布（種子），已散布過就指派持有者（例如加入時的前一段）
  if (msg.type === "need") await (announced.has(msg.i) ? assign(l, msg.i, "repair") : distribute(msg.i));
  if (msg.type === "bad") {
    const b = links.get(msg.peer);
    if (b && !b.bad) {
      b.bad = true;
      m.events.push({ type: "bad", peer: msg.peer, by: l.id, at: nowMs() });
      broadcast({ type: "drop", peer: msg.peer });
    }
  }
  if (msg.type === "status") l.status = msg;
}

let last = { at: performance.now(), bytes: 0 };
setInterval(() => {
  const total = m.sent.seed + m.sent.repair + m.sent.join;
  const now = performance.now();
  m.perSec.push(+(((total - last.bytes) * 8) / ((now - last.at) / 1000) / 1e6).toFixed(1));
  last = { at: now, bytes: total };
}, 1000);

window.lab = {
  open,
  play: () => video.play(),
  pause: () => video.pause(),
  seek: (t) => (video.currentTime = t),
  time: () => video.currentTime,
  metrics: () => ({ ...m, bitrate: src?.bitrate, links: [...links.values()].map((l) => ({ id: l.id, sent: l.sent, upload: l.upload, bad: l.bad, queued: l.out.queued, buffered: l.data.bufferedAmount, dc: l.data.readyState })) }),
};
producer();
log("host ready");
