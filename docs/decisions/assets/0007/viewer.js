/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型：收看端。DataChannel → fMP4 → MSE（影音各一個 SourceBuffer），依房主狀態對時追趕。
// 不是正式程式碼。
import {
  KIND_INIT,
  TRACK_VIDEO,
  catchUp,
  clockEstimator,
  expectedMediaTime,
  nowMs,
  reassembler,
  signalBus,
} from "./proto.js";

const q = new URLSearchParams(location.search);
const id = q.get("id") ?? crypto.randomUUID().slice(0, 8);
const BACK_S = Number(q.get("back") ?? 10); // 保留已播過的秒數，之前的清掉
const DEAD_S = Number(q.get("dead") ?? 0.015);
const video = document.querySelector("video");
const log = (m) => (document.querySelector("#log").textContent += m + "\n");

const clock = clockEstimator();
const sbs = [null, null];
const queues = [[], []];
let ms = null;
let host = null; // 房主最後一次廣播的狀態
let epoch = 0;
let started = false;
let seekLead = 0.2;
let lastSeekAt = 0;
let tick = 0;
let mediaAppended = false;
let holding = false;
const metrics = {
  id,
  frames: [],
  t: { hello: nowMs() },
  dropped: 0,
  quotaHits: 0,
  evictions: 0,
  seeks: 0,
  rates: [],
  syncedAfterEpoch: [],
  timeline: [],
  rxBytes: 0,
  rxMsgs: 0,
  dbg: [],
  holds: 0,
};

const send = signalBus(async (m) => {
  if (m.to !== id) return;
  if (m.type === "offer") {
    await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    send({ type: "answer", from: id, sdp: pc.localDescription.sdp });
  }
  if (m.type === "ice" && m.cand) await pc.addIceCandidate(m.cand);
});

const pc = new RTCPeerConnection();
let ctl = null;
pc.onicecandidate = (e) => send({ type: "ice", from: id, cand: e.candidate?.toJSON() ?? null });
pc.ondatachannel = (e) => {
  const dc = e.channel;
  if (dc.label === "ctl") {
    ctl = dc;
    dc.onmessage = (ev) => onCtl(JSON.parse(ev.data));
    metrics.t.dcOpen = nowMs();
    pingBurst();
  } else {
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => {
      metrics.rxBytes += ev.data.byteLength;
      metrics.rxMsgs++;
      onData(ev.data);
    };
  }
};
send({ type: "hello", from: id });

function pingBurst() {
  let n = 0;
  const tick = () => {
    if (ctl?.readyState === "open") ctl.send(JSON.stringify({ type: "ping", t0: nowMs() }));
    n++;
    setTimeout(tick, n < 8 ? 50 : 2000);
  };
  tick();
}

function onCtl(m) {
  if (m.type === "pong") clock.add(m.t0, m.t1, nowMs());
  if (m.type === "tracks") {
    epoch = m.epoch;
    setupMse(m);
  }
  if (m.type === "state") {
    if (m.epoch > epoch) advanceEpoch(m.epoch);
    host = m;
  }
}

function setupMse(m) {
  ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  ms.addEventListener(
    "sourceopen",
    () => {
      sbs[0] = ms.addSourceBuffer(m.video);
      if (m.audio) sbs[1] = ms.addSourceBuffer(m.audio);
      for (const [i, sb] of sbs.entries()) sb?.addEventListener("updateend", () => pumpQueue(i));
      metrics.t.mse = nowMs();
      ctl.send(JSON.stringify({ type: "ready" }));
    },
    { once: true },
  );
}

const onData = reassembler((seg) => {
  dbg({ ev: "seg", e: seg.epoch, k: seg.kind, tr: seg.track, n: seg.bytes.byteLength, cur: epoch });
  if (seg.kind !== KIND_INIT && seg.epoch < epoch) return; // 跳轉前送出的舊資料
  if (seg.kind !== KIND_INIT && seg.epoch > epoch) advanceEpoch(seg.epoch);
  metrics.t.firstData ??= nowMs();
  if (seg.kind !== KIND_INIT) mediaAppended = true;
  queues[seg.track === TRACK_VIDEO ? 0 : 1].push({ op: "append", init: seg.kind === KIND_INIT, bytes: seg.bytes });
  pumpQueue(seg.track === TRACK_VIDEO ? 0 : 1);
});

function dbg(x) {
  if (!q.get("debug")) return;
  metrics.dbg.push({ t: Math.round(nowMs() - metrics.t.hello), ...x });
  if (metrics.dbg.length > 3000) metrics.dbg.splice(0, 1000);
}
function rangesOf(sb) {
  return sb ? [...Array(sb.buffered.length).keys()].map((i) => [+sb.buffered.start(i).toFixed(2), +sb.buffered.end(i).toFixed(2)]) : [];
}

function advanceEpoch(e) {
  dbg({ ev: "epoch", e, appended: mediaAppended });
  epoch = e;
  metrics.epochAt = { epoch: e, at: nowMs() };
  if (!mediaAppended) return; // 還沒收到任何媒體資料：只更新 epoch，不清緩衝
  for (let i = 0; i < 2; i++) {
    const sb = sbs[i];
    if (!sb) continue;
    queues[i] = queues[i].filter((x) => x.init); // init segment 一定要保留
    try {
      if (sb.updating) sb.abort();
    } catch {
      /* 正在 remove 時 abort 會丟例外，等它完成 */
    }
    queues[i].push({ op: "remove", start: 0, end: Infinity });
    pumpQueue(i);
  }
}

function pumpQueue(i) {
  const sb = sbs[i];
  if (!sb || sb.updating || queues[i].length === 0) return;
  const job = queues[i][0];
  dbg({ ev: "job", i, op: job.op, init: job.init, before: rangesOf(sb) });
  try {
    if (job.op === "append") sb.appendBuffer(job.bytes);
    else sb.remove(job.start, Math.min(job.end, ms.duration || 1e9));
    queues[i].shift();
  } catch (err) {
    if (err.name === "QuotaExceededError") {
      metrics.quotaHits++;
      const cut = video.currentTime - 1;
      if (cut > 0) queues[i].unshift({ op: "remove", start: 0, end: cut });
      setTimeout(() => pumpQueue(i), 200);
    } else {
      queues[i].shift();
      log(`sb${i} ${err.name}: ${err.message}`);
    }
  }
}

function bufferedAhead(sb, t) {
  if (!sb) return Infinity;
  const b = sb.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) > t) return b.end(i) - t;
  return 0;
}

let lastFrame = null;
function presentedTime() {
  if (!video.paused && !video.seeking && lastFrame && performance.now() - lastFrame.p < 250) {
    return lastFrame.m + ((performance.now() - lastFrame.p) / 1000) * video.playbackRate;
  }
  return video.currentTime;
}

function hostNow() {
  return nowMs() + (clock.best?.offset ?? 0);
}

async function syncTick() {
  if (!host || !clock.best || !sbs[0]) return;
  const exp = expectedMediaTime(host, hostNow());
  const ahead = Math.min(bufferedAhead(sbs[0], exp), bufferedAhead(sbs[1], exp));
  if (++tick % 5 === 0 || !started) {
    metrics.timeline.push({
      t: Math.round(nowMs() - metrics.t.hello),
      exp: +exp.toFixed(3),
      cur: +video.currentTime.toFixed(3),
      ahead: +ahead.toFixed(2),
      rs: video.readyState,
      sk: video.seeking,
      p: video.paused,
    });
    if (metrics.timeline.length > 400) metrics.timeline.splice(0, 100);
  }
  if (!started) {
    if (ahead < 0.5) return;
    video.currentTime = exp + (host.playing ? seekLead : 0);
    started = true;
    metrics.t.firstSeek = nowMs();
    if (host.playing) await video.play().catch((e) => log(`play ${e}`));
    return;
  }
  if (holding) return;
  if (!host.playing) {
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - exp) > 0.05 && !video.seeking && ahead > 0.1) video.currentTime = exp;
    return;
  }
  if (video.seeking) return;
  const drift = presentedTime() - exp;
  const c = catchUp(drift, { dead: DEAD_S });
  // 差距大就跳轉：要在 readyState 檢查之前（跳轉後舊位置的緩衝已清掉，readyState 會停在 2）
  if (c.action !== "seek" && video.readyState < 3) return;
  if (video.paused) await video.play().catch(() => {});
  if (c.action === "seek") {
    if (ahead < 0.5 || nowMs() - lastSeekAt < 1000) return;
    lastSeekAt = nowMs();
    metrics.seeks++;
    const t0 = nowMs();
    video.currentTime = exp + seekLead;
    video.addEventListener(
      "seeked",
      () => {
        seekLead = Math.min(1, Math.max(0.05, (nowMs() - t0) / 1000 + 0.05));
      },
      { once: true },
    );
    return;
  }
  if (c.action === "hold") {
    if (holding) return;
    holding = true;
    metrics.holds++;
    video.pause();
    setTimeout(() => {
      holding = false;
      video.play().catch(() => {});
    }, c.ms);
    return;
  }
  if (video.playbackRate !== c.rate) video.playbackRate = c.rate;
  if (metrics.epochAt && !video.paused) {
    let rec = metrics.syncedAfterEpoch.find((x) => x.epoch === epoch);
    if (!rec) metrics.syncedAfterEpoch.push((rec = { epoch }));
    const ms = Math.round(nowMs() - metrics.epochAt.at);
    if (Math.abs(drift) < 0.1) rec.ms100 ??= ms;
    if (Math.abs(drift) < 0.05) rec.ms50 ??= ms;
  }
  metrics.t.synced ??= Math.abs(drift) < 0.05 ? nowMs() : undefined;
  metrics.rates.push(c.rate);
  if (metrics.rates.length > 600) metrics.rates.shift();
}
setInterval(syncTick, 100);

setInterval(() => {
  if (ctl?.readyState !== "open") return;
  const t = video.currentTime;
  ctl.send(
    JSON.stringify({
      type: "status",
      epoch,
      currentTime: t,
      aheadV: bufferedAhead(sbs[0], t),
      aheadA: bufferedAhead(sbs[1], t),
      aheadAtTarget: host && clock.best ? Math.min(bufferedAhead(sbs[0], expectedMediaTime(host, hostNow())), bufferedAhead(sbs[1], expectedMediaTime(host, hostNow()))) : 0,
      readyState: video.readyState,
    }),
  );
  // 清掉已播過的緩衝：基準要取 min(currentTime, 應在時間)。房主往回跳轉後 currentTime 還停在舊位置，
  // 只看 currentTime 會把剛收到的新資料當成「已播過」清掉（原型實際踩到）。
  const exp = host && clock.best ? expectedMediaTime(host, hostNow()) : t;
  const base = Math.min(t, exp);
  for (let i = 0; i < 2; i++) {
    const sb = sbs[i];
    if (sb && sb.buffered.length && sb.buffered.start(0) < base - BACK_S - 2) {
      metrics.evictions++;
      queues[i].push({ op: "remove", start: 0, end: base - BACK_S });
      pumpQueue(i);
    }
  }
}, 250);

video.requestVideoFrameCallback(function onFrame(_n, md) {
  metrics.frames.push({ w: performance.timeOrigin + md.expectedDisplayTime, m: md.mediaTime });
  lastFrame = { p: md.expectedDisplayTime, m: md.mediaTime };
  video.requestVideoFrameCallback(onFrame);
});
video.addEventListener("playing", () => (metrics.t.playing ??= nowMs()));

window.lab = {
  metrics: () => ({
    ...metrics,
    clock: clock.best,
    time: video.currentTime,
    rate: video.playbackRate,
    dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
    total: video.getVideoPlaybackQuality().totalVideoFrames,
    queues: queues.map((x) => x.length),
    logText: document.querySelector("#log").textContent.slice(-800),
    pcState: pc.connectionState,
    bufV: sbs[0] ? [...Array(sbs[0].buffered.length).keys()].map((i) => [sbs[0].buffered.start(i), sbs[0].buffered.end(i)]) : [],
  }),
  clearFrames: () => {
    metrics.frames = [];
  },
};
log(`viewer ${id}`);
