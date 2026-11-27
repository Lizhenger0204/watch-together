/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型：房主端「原片直送」。拆檔（mediabunny）→ fMP4 片段 → 每位收看者一條 DataChannel。
// 房主本機 <video> 照常播原檔，是全房的主時鐘。不是正式程式碼。
import { describeTrack, initSegment, mediaSegment } from "./fmp4.js";
import {
  KIND_INIT,
  KIND_MEDIA,
  TRACK_AUDIO,
  TRACK_VIDEO,
  chunkSegment,
  nowMs,
  signalBus,
} from "./proto.js";

const q = new URLSearchParams(location.search);
const MB_URL = q.get("mb") ?? "https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs";
const LEAD_S = Number(q.get("lead") ?? 20); // 每位收看者的資料最多超前播放進度幾秒
const HIGH = Number(q.get("high") ?? 1 << 20); // bufferedAmount 高水位
const LOW = Number(q.get("low") ?? 256 << 10); // bufferedamountlow 門檻
const CHUNK = Number(q.get("chunk") ?? 64 << 10);
const PACE_STEADY = Number(q.get("pace") ?? 1.5);
const PACE_CATCHUP = Number(q.get("paceCatchup") ?? 6);
const CATCHUP_S = 5;
const MIN_PACE_BPS = 8e6;
const BUDGET_BPS = Number(q.get("budget") ?? 100) * 1e6; // 房主總上傳預算（Mbps）
const SMART_START = q.get("smartStart") !== "0";
const SEEK_WAIT = q.get("seekWait") === "1"; // 跳轉後房主先暫停，等收看者緩衝好（或逾時）再一起播
const SEEK_WAIT_MAX_MS = 8000;
const VIDEO_FRAG_S = 2; // 影像片段最長 2 秒（GOP 更長時切成多段，只有第一段以關鍵影格開頭）
const AUDIO_FRAG_S = 1;

const video = document.querySelector("video");
const log = (m) => (document.querySelector("#log").textContent += m + "\n");
const links = new Map();
let src = null;
let epoch = 1;
const metrics = { frames: [], sentBytes: 0, events: [] };

const send = signalBus(onSignal);

async function openSource(blob) {
  const MB = await import(MB_URL);
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  const at = await input.getPrimaryAudioTrack();
  const vcfg = await vt.getDecoderConfig();
  const acfg = at ? await at.getDecoderConfig() : null;
  const v = describeTrack("video", vcfg, 1);
  const a = acfg ? describeTrack("audio", acfg, 2) : null;
  src = {
    MB,
    vSink: new MB.EncodedPacketSink(vt),
    aSink: at ? new MB.EncodedPacketSink(at) : null,
    v,
    a,
    vInit: initSegment(v),
    aInit: a ? initSegment(a) : null,
    format: (await input.getFormat()).name,
    firstPts: (await new MB.EncodedPacketSink(vt).getFirstPacket()).timestamp,
  };
  video.src = URL.createObjectURL(blob);
  await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  src.bitrate = (blob.size * 8) / video.duration;
  log(`source ${src.format} ${v.mime} ${a?.mime ?? "no audio"} ${v.width}x${v.height}`);
  return { format: src.format, video: v.mime, audio: a?.mime ?? null, firstPts: src.firstPts, mbps: +(src.bitrate / 1e6).toFixed(1) };
}

let lastFrame = null;
/** 目前「畫面上」的媒體時間：最近一張已顯示畫面（rVFC）往後推；拿不到就用 currentTime。 */
function presentedTime() {
  const playing = !video.paused && !video.seeking;
  if (playing && lastFrame && performance.now() - lastFrame.p < 250) {
    return lastFrame.m + ((performance.now() - lastFrame.p) / 1000) * video.playbackRate;
  }
  return video.currentTime;
}
function state() {
  return {
    type: "state",
    epoch,
    playing: !video.paused && !video.seeking && video.readyState >= 3,
    mediaTime: presentedTime(),
    hostClock: nowMs(),
    rate: video.playbackRate,
  };
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const l of links.values()) if (l.ctl?.readyState === "open") l.ctl.send(s);
}
for (const ev of ["play", "pause", "playing", "waiting", "seeked", "ratechange"]) {
  video.addEventListener(ev, () => broadcast(state()));
}
video.addEventListener("seeking", () => {
  epoch++;
  metrics.events.push({ type: "seek", epoch, at: nowMs(), to: video.currentTime });
  for (const l of links.values()) {
    l.epoch = epoch;
    l.startTime = video.currentTime;
    l.reported = null;
  }
  broadcast({ ...state(), playing: false });
  if (SEEK_WAIT && !video.paused && !waitingForViewers) holdUntilViewersReady();
});

let waitingForViewers = false;
async function holdUntilViewersReady() {
  waitingForViewers = true;
  const my = epoch;
  video.pause();
  const t0 = performance.now();
  await new Promise((r) => video.addEventListener("seeked", r, { once: true }));
  while (performance.now() - t0 < SEEK_WAIT_MAX_MS && my === epoch) {
    const ready = [...links.values()].every((l) => l.closed || (l.reported?.epoch === my && l.reported.aheadAtTarget >= 1));
    if (ready) break;
    await sleep(100);
  }
  metrics.events.push({ type: "seekWait", epoch: my, ms: Math.round(performance.now() - t0) });
  waitingForViewers = false;
  if (my === epoch) video.play();
}
setInterval(() => broadcast(state()), 1000);
video.requestVideoFrameCallback(function onFrame(_n, md) {
  metrics.frames.push({ w: performance.timeOrigin + md.expectedDisplayTime, m: md.mediaTime });
  lastFrame = { p: md.expectedDisplayTime, m: md.mediaTime };
  video.requestVideoFrameCallback(onFrame);
});

async function onSignal(msg) {
  if (msg.type === "hello") return connect(msg.from);
  const l = links.get(msg.from);
  if (!l) return;
  if (msg.type === "answer") await l.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  if (msg.type === "ice" && msg.cand) await l.pc.addIceCandidate(msg.cand);
}

async function connect(id) {
  links.get(id)?.pc.close();
  const pc = new RTCPeerConnection();
  const l = { id, pc, epoch, startTime: video.currentTime, reported: null, closed: false, sent: 0 };
  links.set(id, l);
  pc.onicecandidate = (e) => send({ type: "ice", to: id, cand: e.candidate?.toJSON() ?? null });
  l.ctl = pc.createDataChannel("ctl", { ordered: true });
  l.data = pc.createDataChannel("data", { ordered: true });
  l.data.binaryType = "arraybuffer";
  l.data.bufferedAmountLowThreshold = LOW;
  l.ctl.onmessage = (e) => onCtl(l, JSON.parse(e.data));
  l.ctl.onopen = () => {
    l.ctl.send(JSON.stringify({ type: "tracks", epoch, video: src.v.mime, audio: src.a?.mime ?? null }));
    l.ctl.send(JSON.stringify(state()));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") l.closed = true;
  };
  await pc.setLocalDescription(await pc.createOffer());
  send({ type: "offer", to: id, sdp: pc.localDescription.sdp });
}

function onCtl(l, m) {
  if (m.type === "ping") l.ctl.send(JSON.stringify({ type: "pong", t0: m.t0, t1: nowMs() }));
  if (m.type === "ready") {
    l.epoch = epoch;
    l.startTime = video.currentTime;
    pump(l).catch((e) => log(`pump ${l.id}: ${e}`));
  }
  if (m.type === "status") l.reported = m;
}

/**
 * 加入或跳轉時從哪個關鍵影格開始送（ADR 0007 D3）：
 * - 前一個關鍵影格 Kp：要先補 (t − Kp + X) 秒的資料，同時目標以 1 倍速前進，
 *   需要 (t − Kp + X)·b ÷ (r − b) 秒（r ≤ b 時追不上）。
 * - 下一個關鍵影格 Kn：等房主播到 Kn，期間送 X 秒資料，需要 max(Kn − t, X·b ÷ r) 秒。
 * 取估計較短者。b = 片源位元率，r = 這位收看者分到的速率，X = 開播前的緩衝秒數。
 */
async function chooseStartKey(l, t) {
  const prev = (await src.vSink.getKeyPacket(t, { verifyKeyPackets: true })) ?? (await src.vSink.getFirstPacket());
  if (!SMART_START) return prev;
  const next = await src.vSink.getNextKeyPacket(prev, { verifyKeyPackets: true });
  const b = src.bitrate;
  const r = linkRate(PACE_CATCHUP);
  const X = 1;
  const viaPrev = r > b ? ((t - prev.timestamp + X) * b) / (r - b) : Infinity;
  const viaNext = next ? Math.max(next.timestamp - t, (X * b) / r) : Infinity;
  const pick = viaNext < viaPrev ? next : prev;
  metrics.events.push({ type: "startKey", id: l.id, t, prev: prev.timestamp, next: next?.timestamp, viaPrev, viaNext, pick: pick.timestamp });
  return pick;
}

function linkRate(factor) {
  const active = [...links.values()].filter((x) => !x.closed).length || 1;
  return Math.min(BUDGET_BPS / active, Math.max(MIN_PACE_BPS, src.bitrate * factor));
}

/**
 * 配速送出：不一次把整個片段塞進 SCTP。實測爆量送出會讓 loopback 掉包、SCTP 重傳逾時停滯 2～30 秒。
 * 速率 = 片源平均位元率 × 倍數；資料超前不到 CATCHUP_S 秒時用 PACE_CATCHUP 倍（加入、跳轉後追進度）。
 */
async function sendSeg(l, kind, track, seq, bytes, my, lead) {
  // 總上傳預算平分給在線收看者；超過預算時 SCTP 會掉進長時間停滯（原型實測）
  const rate = linkRate(lead < CATCHUP_S ? PACE_CATCHUP : PACE_STEADY);
  for (const c of chunkSegment(kind, track, l.epoch, seq, bytes, CHUNK)) {
    const now = performance.now();
    l.vt = Math.max(l.vt ?? now, now - 50) + ((c.byteLength * 8) / rate) * 1000;
    if (l.vt - now > 15) await sleep(l.vt - now);
    while (l.data.bufferedAmount > HIGH) await drained(l.data);
    if (my !== undefined && my !== l.epoch) return; // 跳轉了：放棄這段（收看端會丟掉沒收完的部分）
    if (l.data.readyState !== "open") return;
    l.data.send(c);
    l.sent += c.byteLength;
    metrics.sentBytes += c.byteLength;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drained = (dc) =>
  new Promise((r) => dc.addEventListener("bufferedamountlow", r, { once: true }));

async function pump(l) {
  await sendSeg(l, KIND_INIT, TRACK_VIDEO, 0, src.vInit);
  if (src.aInit) await sendSeg(l, KIND_INIT, TRACK_AUDIO, 0, src.aInit);
  let my = -1;
  let seq = 1;
  let vIt, aIt, vNext, aNext;
  while (!l.closed && l.data.readyState === "open") {
    if (my !== l.epoch) {
      my = l.epoch;
      const key = await chooseStartKey(l, presentedTime());
      vIt = src.vSink.packets(key);
      vNext = (await vIt.next()).value ?? null;
      if (src.aSink) {
        const ap = (await src.aSink.getPacket(key.timestamp)) ?? (await src.aSink.getFirstPacket());
        aIt = src.aSink.packets(ap);
        aNext = (await aIt.next()).value ?? null;
      }
      metrics.events.push({ type: "restart", id: l.id, epoch: my, from: key.timestamp, at: nowMs() });
      continue;
    }
    if (l.data.bufferedAmount > HIGH) {
      await drained(l.data);
      continue;
    }
    const vt = vNext ? vNext.timestamp : Infinity;
    const at = aNext ? aNext.timestamp : Infinity;
    const next = Math.min(vt, at);
    // 超前量以房主（主時鐘）的媒體時間計算；收看端回報的 currentTime 在跳轉後、重新對上之前沒有意義
    const playhead = presentedTime();
    if (next === Infinity || next > playhead + LEAD_S) {
      await sleep(100);
      continue;
    }
    const isVideo = vt <= at;
    const it = isVideo ? vIt : aIt;
    let cur = isVideo ? vNext : aNext;
    const first = cur.timestamp;
    const limit = isVideo ? VIDEO_FRAG_S : AUDIO_FRAG_S;
    const samples = [];
    while (cur) {
      if (samples.length && isVideo && cur.type === "key") break;
      if (samples.length && cur.timestamp - first >= limit) break;
      samples.push({ pts: cur.timestamp, duration: cur.duration, key: cur.type === "key", data: cur.data });
      cur = (await it.next()).value ?? null;
    }
    if (my !== l.epoch) continue; // 讀檔期間房主跳轉了：丟掉這段
    if (isVideo) vNext = cur;
    else aNext = cur;
    const t = isVideo ? src.v : src.a;
    const bytes = mediaSegment({ trackId: t.trackId, timescale: t.timescale, seq, samples });
    await sendSeg(l, KIND_MEDIA, isVideo ? TRACK_VIDEO : TRACK_AUDIO, seq++, bytes, my, first - playhead);
  }
}

document.querySelector("#file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) await openSource(f);
});

window.lab = {
  open: (url) =>
    fetch(url)
      .then((r) => r.blob())
      .then(openSource),
  openFile: () => openSource(document.querySelector("#file").files[0]),
  play: () => video.play(),
  pause: () => video.pause(),
  seek: (t) => {
    video.currentTime = t;
  },
  metrics: () => ({
    ...metrics,
    links: [...links.values()].map((l) => ({
      id: l.id,
      sent: l.sent,
      buffered: l.data?.bufferedAmount,
      reported: l.reported,
    })),
    time: video.currentTime,
    logText: document.querySelector("#log").textContent.slice(-1500),
    dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
  }),
  clearFrames: () => {
    metrics.frames = [];
  },
  diag: async () => {
    const out = [];
    for (const l of links.values()) {
      const st = await l.pc.getStats();
      const rows = [];
      st.forEach((r) => {
        if (r.type === "candidate-pair" && r.nominated) rows.push({ t: r.type, state: r.state, sent: r.bytesSent, recv: r.bytesReceived, rtt: r.currentRoundTripTime, out: r.availableOutgoingBitrate });
        if (r.type === "data-channel") rows.push({ t: r.type, label: r.label, msgs: r.messagesSent, bytes: r.bytesSent, state: r.state });
        if (r.type === "transport") rows.push({ t: r.type, sel: r.selectedCandidatePairChanges, dtls: r.dtlsState });
      });
      out.push({ id: l.id, buffered: l.data.bufferedAmount, sctp: l.pc.sctp?.state, maxMsg: l.pc.sctp?.maxMessageSize, rows });
    }
    return out;
  },
};
log("host ready");
