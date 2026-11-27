/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 種子式散布原型：收看端。hls.js 負責 MSE 與緩衝，片段由自訂 loader 從「片段倉庫」取；
// 倉庫的資料來自房主或其他收看者（DataChannel），每段都先比對房主在 pt-ctl 公布的 SHA-256。不是正式程式碼。
import { INIT_SEG, bus, nowMs, pacer, pct, reassembler, sender, sha256, sleep } from "./swarm-common.js";

const q = new URLSearchParams(location.search);
const HLS_URL = q.get("hls") ?? "https://cdn.jsdelivr.net/npm/hls.js@1.7.4/dist/hls.light.min.mjs";
const ME = q.get("id") ?? `v${Math.random().toString(36).slice(2, 7)}`;
const UPLOAD = q.get("upload") !== "0";
const UP_BPS = Number(q.get("up") ?? 40) * 1e6; // 這位收看者的上傳配速上限
const EVIL = q.get("evil") === "1"; // 轉送給別人時竄改一個位元組（驗證雜湊用）
const URGENT_S = 3; // 片段開始時間距應在時間不到 3 秒＝急件
const PEER_WAIT_MS = 1500; // 急件向其他收看者等這麼久還沒到，就向房主補拿

const video = document.querySelector("video");
const log = (m) => (document.querySelector("#log").textContent += m + "\n");
const send = bus(ME, onSignal);
const upPace = pacer(UP_BPS);
const store = new Map(); // i → bytes（已驗證）
const ann = new Map(); // i → { sha, size, start, from, askedAt, askedHost }
const waiters = new Map();
const peers = new Map();
const badPeers = new Set();
const early = new Map();
const wanted = new Set(); // 播放器正在等的片段（一律算急件）
const standing = new Map(); // i → Set(peer)：別人先來要、我還沒有的片段
const m = { id: ME, upload: UPLOAD, fromHost: 0, fromPeers: 0, uploaded: 0, hashFail: 0, repairs: 0, dupBytes: 0, drift: [], waiting: 0, joinAt: nowMs(), firstFrameAt: null, seekRecover: [] };
let host = null;
let manifest = null;
let initBytes = null;
let st = null;
let hls = null;

function onSignal(msg) {
  if (msg.from === "host") return hostSignal(msg);
  if (msg.type === "pair" && (msg.a === ME || msg.b === ME)) return connectPeer(msg.a === ME ? msg.b : msg.a);
  if (msg.type === "unpair") return closePeer(msg.peer);
  const p = peers.get(msg.from);
  if (msg.type === "offer") return answerPeer(msg);
  if (msg.type === "answer") p?.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  if (msg.type === "ice" && msg.cand) p?.pc.addIceCandidate(msg.cand).catch(() => {});
}

async function hostSignal(msg) {
  if (msg.type === "pair" && (msg.a === ME || msg.b === ME)) return connectPeer(msg.a === ME ? msg.b : msg.a);
  if (msg.type === "unpair") return closePeer(msg.peer);
  if (msg.type === "offer") {
    const pc = new RTCPeerConnection();
    host = { pc };
    pc.onicecandidate = (e) => send("host", { type: "ice", cand: e.candidate?.toJSON() ?? null });
    pc.ondatachannel = ({ channel }) => {
      channel.binaryType = "arraybuffer";
      if (channel.label === "pt-ctl") {
        host.ctl = channel;
        channel.onmessage = (e) => onHostCtl(JSON.parse(e.data));
      } else channel.onmessage = ((r) => (e) => r(e.data))(reassembler((seg, bytes) => receive(seg, bytes, "host")));
    };
    await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    send("host", { type: "answer", sdp: pc.localDescription.sdp });
  }
  if (msg.type === "ice" && msg.cand) host?.pc.addIceCandidate(msg.cand);
}
const toHost = (msg) => host?.ctl?.readyState === "open" && host.ctl.send(JSON.stringify(msg));

/** 收看者之間：id 較小的一方發起。兩條頻道：sw-ctl（要求）與 sw-data（片段）。 */
function peerObj(id) {
  const pc = new RTCPeerConnection();
  const p = { id, pc, open: false };
  peers.set(id, p);
  pc.onicecandidate = (e) => send(id, { type: "ice", cand: e.candidate?.toJSON() ?? null });
  pc.onconnectionstatechange = () => ["failed", "closed"].includes(pc.connectionState) && closePeer(id);
  const wire = (ch) => {
    ch.binaryType = "arraybuffer";
    if (ch.label === "sw-ctl") {
      p.ctl = ch;
      ch.onopen = () => (p.open = true);
      ch.onmessage = (e) => onPeerCtl(p, JSON.parse(e.data));
      ch.onclose = () => closePeer(id);
    } else {
      p.data = ch;
      p.out = sender(ch, upPace, (_s, n) => (m.uploaded += n), (i) => manifest.segs[i][1] < expected() - 1);
      ch.onmessage = ((r) => (e) => r(e.data))(reassembler((seg, bytes) => receive(seg, bytes, id)));
    }
  };
  p.wire = wire;
  return p;
}
async function connectPeer(id) {
  if (peers.has(id) || ME > id) return; // 較小的 id 發起
  const p = peerObj(id);
  p.wire(p.pc.createDataChannel("sw-ctl"));
  p.wire(p.pc.createDataChannel("sw-data"));
  await p.pc.setLocalDescription(await p.pc.createOffer());
  send(id, { type: "offer", sdp: p.pc.localDescription.sdp, pair: true });
}
async function answerPeer(msg) {
  const p = peers.get(msg.from) ?? peerObj(msg.from);
  p.pc.ondatachannel = ({ channel }) => p.wire(channel);
  await p.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
  await p.pc.setLocalDescription(await p.pc.createAnswer());
  send(msg.from, { type: "answer", sdp: p.pc.localDescription.sdp });
}
function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  peers.delete(id);
  p.pc.close();
  for (const [i, a] of ann) if (a.from === id && !store.has(i)) toHost({ type: "where", i }); // 換來源
}

function onPeerCtl(p, msg) {
  if (msg.type !== "req" || !UPLOAD) return;
  if (store.has(msg.i)) return serve(p, msg.i);
  if (!standing.has(msg.i)) standing.set(msg.i, new Set());
  standing.get(msg.i).add(p.id); // 還沒有：拿到後再送
}
function serve(p, i) {
  const a = ann.get(i);
  const mutate = EVIL ? (b) => ((b = b.slice()), (b[b.length >> 1] ^= 0xff), b) : undefined;
  p.out?.push(i, store.get(i), a?.start ?? 0, "peer", mutate);
}

function onHostCtl(msg) {
  if (msg.type === "manifest") {
    manifest = msg;
    toHost({ type: "ready" });
    startPlayer();
  }
  if (msg.type === "state") st = { ...msg, at: nowMs() };
  if (msg.type === "seg") {
    if (store.has(msg.i)) return;
    ann.set(msg.i, { ...msg, askedAt: performance.now(), askedHost: msg.from === "host" });
    if (early.has(msg.i)) {
      const e = early.get(msg.i);
      early.delete(msg.i);
      return receive(msg.i, e.bytes, e.from);
    }
    if (msg.from !== "host") ask(msg.i, msg.from); // 對方收到重複要求只會排一次
  }
  if (msg.type === "drop") badPeers.add(msg.peer);
}
function ask(i, from) {
  const p = peers.get(from);
  if (!p?.open || badPeers.has(from)) return toHost({ type: "where", i });
  p.ctl.send(JSON.stringify({ type: "req", i }));
}

async function receive(i, bytes, from) {
  const n = bytes.byteLength;
  if (from === "host") m.fromHost += n;
  else m.fromPeers += n;
  if (i === INIT_SEG) {
    if ((await sha256(bytes)) !== manifest.initSha) return log("init hash mismatch");
    initBytes = bytes;
    return wake(INIT_SEG);
  }
  const a = ann.get(i);
  if (store.has(i)) return void (m.dupBytes += n); // 重複收到（記帳用）
  if (!a) return early.set(i, { bytes, from }); // 資料比公布早到（不同頻道之間沒有順序保證）：等公布再驗
  if ((await sha256(bytes)) !== a.sha) {
    m.hashFail++;
    if (from !== "host") {
      badPeers.add(from);
      toHost({ type: "bad", peer: from });
    }
    a.askedHost = true;
    m.repairs++;
    return toHost({ type: "req", i });
  }
  store.set(i, bytes);
  wake(i);
  for (const pid of standing.get(i) ?? []) peers.get(pid) && serve(peers.get(pid), i);
  standing.delete(i);
}
function wake(i) {
  for (const r of waiters.get(i) ?? []) r();
  waiters.delete(i);
}
const until = (i, ok) => (ok() ? Promise.resolve() : new Promise((r) => waiters.set(i, [...(waiters.get(i) ?? []), r])));

/** 應在時間（同一台機器，時鐘相同，原型省略對時）。 */
const expected = () => (st ? (st.playing ? st.mediaTime + ((nowMs() - st.hostClock) / 1000) * st.rate : st.mediaTime) : 0);

/** 看門狗：急件向房主補拿；清掉 30 秒前的片段；回報持有清單。 */
setInterval(() => {
  if (!manifest) return;
  const E = expected();
  for (const [i, a] of ann) {
    if (store.has(i) || a.askedHost) continue;
    const urgent = a.start - E < URGENT_S && (wanted.has(i) || manifest.segs[i][1] > E); // 預讀不算急件
    if (urgent && performance.now() - a.askedAt > PEER_WAIT_MS) {
      a.askedHost = true;
      m.repairs++;
      toHost({ type: "req", i });
    }
  }
  for (const i of store.keys()) if (manifest.segs[i][1] < E - 30) store.delete(i);
  toHost({ type: "have", have: [...store.keys()] });
}, 250);

/** hls.js 自訂 loader：播放清單、init、片段都從記憶體倉庫拿，不走網路。 */
class PtLoader {
  constructor() {
    this.stats = { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
  }
  async load(ctx, _cfg, cbs) {
    const s = this.stats;
    this.ctx = ctx;
    this.cbs = cbs;
    s.loading.start = performance.now();
    const name = ctx.url.split("/").pop();
    if (q.get("debug")) log(`load ${name}`);
    await sleep(0); // hls.js 預期 loader 非同步回呼
    let data;
    if (name === "playlist.m3u8") data = manifest.playlist;
    else if (name === "init.mp4") data = (await until(INIT_SEG, () => initBytes), initBytes).buffer.slice(0);
    else {
      const i = Number(name.split(".")[0]);
      if (!ann.has(i)) toHost({ type: "need", i });
      wanted.add(i);
      await until(i, () => store.has(i));
      wanted.delete(i);
      const b = store.get(i);
      data = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    if (s.aborted) return;
    s.loading.first = s.loading.end = performance.now();
    s.loaded = s.total = typeof data === "string" ? data.length : data.byteLength;
    cbs.onSuccess({ url: ctx.url, data }, s, ctx, null);
  }
  abort() {
    if (this.stats.aborted) return;
    this.stats.aborted = true;
    this.cbs?.onAbort?.(this.stats, this.ctx, null); // hls.js 靠 onAbort 結束這次載入
  }
  destroy() {}
}

async function startPlayer() {
  log("startPlayer");
  while (!st) await sleep(50);
  log("import hls");
  const { default: Hls } = await import(HLS_URL);
  hls = new Hls({ debug: !!q.get("debug"), loader: PtLoader, maxBufferLength: 15, backBufferLength: 10, startPosition: expected(), enableWorker: true, fragLoadPolicy: { default: { maxTimeToFirstByteMs: 30000, maxLoadTimeMs: 60000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 2000 } } } });
  hls.on(Hls.Events.ERROR, (_e, d) => log(`hls ${d.type} ${d.details} fatal=${d.fatal}`));
  if (q.get("debug")) for (const ev of ["MANIFEST_PARSED", "LEVEL_LOADED", "FRAG_LOADING", "FRAG_LOADED", "FRAG_BUFFERED", "BUFFER_CODECS", "MEDIA_ATTACHED"]) hls.on(Hls.Events[ev], (_e, d) => log(`${ev} ${d.frag?.sn ?? ""}`));
  hls.attachMedia(video);
  await new Promise((r) => hls.once(Hls.Events.MEDIA_ATTACHED, r));
  hls.loadSource("http://pt.local/playlist.m3u8");
  video.muted = true;
  video.requestVideoFrameCallback(function f(_n, md) {
    lastFrame = { p: md.expectedDisplayTime, m: md.mediaTime };
    if (!m.firstFrameAt && !video.paused) m.firstFrameAt = nowMs();
    video.requestVideoFrameCallback(f);
  });
  syncLoop();
}

let lastFrame = null;
const presented = () => (!video.paused && !video.seeking && lastFrame && performance.now() - lastFrame.p < 250 ? lastFrame.m + ((performance.now() - lastFrame.p) / 1000) * video.playbackRate : video.currentTime);
const buffered = (t, ahead) => [...Array(video.buffered.length).keys()].some((k) => video.buffered.start(k) <= t + 0.05 && video.buffered.end(k) >= t + ahead);
video.addEventListener("waiting", () => m.waiting++);
const inStore = (t) => {
  const i = manifest.segs.findIndex(([a, b]) => a <= t && t < b);
  return i >= 0 && store.has(i) && (manifest.segs[i][1] - t > 0.5 || store.has(i + 1) || i === manifest.segs.length - 1);
};

/** 簡化追趕：落後或超前 > 0.4 秒且目標已緩衝就跳；其他用 ±5% 調速。正式規則見附錄 C §2。 */
async function syncLoop() {
  let lastSeek = 0;
  let seekAt = null;
  for (;;) {
    await sleep(100);
    if (!st) continue;
    const E = expected();
    if (!st.playing) {
      if (!video.paused) video.pause();
      if (Math.abs(video.currentTime - E) > 0.1 && buffered(E, 0.1)) video.currentTime = E;
      continue;
    }
    const d = presented() - E;
    if (Math.abs(d) > 0.4) {
      // 落點所在片段已在倉庫（hls.js 會立刻從倉庫載入）才跳；正式版的條件見附錄 C §2
      if (performance.now() - lastSeek > 1000 && (buffered(E + 0.3, 0.5) || inStore(E + 0.3))) {
        video.currentTime = E + 0.3;
        lastSeek = performance.now();
        seekAt ??= nowMs();
      }
      if (!video.paused && d > 0.4 && d < 3) video.pause();
      continue;
    }
    if (video.paused && buffered(E, 0.3)) video.play().catch(() => {});
    if (!video.paused && !video.seeking) {
      video.playbackRate = Math.abs(d) <= 0.015 ? st.rate : st.rate * (1 - Math.sign(d) * Math.min(0.05, 0.5 * Math.abs(d)));
      m.drift.push({ t: nowMs(), d: +(d * 1000).toFixed(1) });
      if (seekAt && Math.abs(d) < 0.1) (m.seekRecover.push(Math.round(nowMs() - seekAt)), (seekAt = null));
    }
  }
}

window.lab = {
  metrics: (since = 0) => {
    const ds = m.drift.filter((x) => x.t >= since).map((x) => Math.abs(x.d));
    return { ...m, drift: undefined, driftN: ds.length, p50: pct(ds, 50), p95: pct(ds, 95), stored: store.size, peers: [...peers.keys()], badPeers: [...badPeers], dropped: video.getVideoPlaybackQuality().droppedVideoFrames, time: video.currentTime, startMs: m.firstFrameAt ? Math.round(m.firstFrameAt - m.joinAt) : null };
  },
  drift: () => m.drift,
  debug: () => ({ wanted: [...wanted].map((i) => ({ i, ann: ann.get(i) && { ...ann.get(i), sha: undefined, age: Math.round(performance.now() - ann.get(i).askedAt) } })), standing: [...standing].map(([i, set]) => [i, [...set]]), peers: [...peers.values()].map((p) => ({ id: p.id, open: p.open, data: p.data?.readyState, out: !!p.out, queued: p.out?.queued })), hostData: host?.pc.connectionState, stored: [...store.keys()], early: [...early.keys()], ann: [...ann.keys()], E: expected(), st }),
  expected,
};
send("host", { type: "hello", upload: UPLOAD });
log(`viewer ${ME} upload=${UPLOAD}${EVIL ? " EVIL" : ""}`);
