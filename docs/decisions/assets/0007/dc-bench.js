/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型：DataChannel 吞吐與背壓量測。?role=host|viewer&id=&chunk=&high=&low=&rate=(Mbps，0=不限速)
// 房主對每位收看者盡量送（或依 rate 配速），每 500 ms 記錄一次送出／收到量。不是正式程式碼。
import { nowMs, signalBus } from "./proto.js";

const q = new URLSearchParams(location.search);
const role = q.get("role");
const id = q.get("id") ?? "h";
const CHUNK = Number(q.get("chunk") ?? 65536);
const HIGH = Number(q.get("high") ?? 1 << 20);
const LOW = Number(q.get("low") ?? 256 << 10);
const RATE = Number(q.get("rate") ?? 0) * 1e6; // bps
const stats = { samples: [], stalls: 0, maxStallMs: 0, received: 0 };
window.bench = { stats };

if (role === "host") {
  const links = new Map();
  const send = signalBus(async (m) => {
    if (m.type === "hello") {
      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel("data", { ordered: true });
      dc.bufferedAmountLowThreshold = LOW;
      const l = { pc, dc, sent: 0 };
      links.set(m.from, l);
      pc.onicecandidate = (e) => send({ type: "ice", to: m.from, cand: e.candidate?.toJSON() ?? null });
      dc.onopen = () => run(l);
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: "offer", to: m.from, sdp: pc.localDescription.sdp });
    } else if (m.type === "answer") await links.get(m.from).pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
    else if (m.type === "ice" && m.cand) await links.get(m.from)?.pc.addIceCandidate(m.cand);
  });
  const payload = new Uint8Array(CHUNK);
  crypto.getRandomValues(payload.subarray(0, 65536));
  async function run(l) {
    const t0 = nowMs();
    let lastProgress = nowMs();
    let lastBuffered = 0;
    const timer = setInterval(() => {
      const b = l.dc.bufferedAmount;
      if (b > 0 && b >= lastBuffered) {
        const stall = nowMs() - lastProgress;
        if (stall > 1000) stats.maxStallMs = Math.max(stats.maxStallMs, stall);
      } else lastProgress = nowMs();
      lastBuffered = b;
    }, 100);
    while (l.dc.readyState === "open") {
      if (l.dc.bufferedAmount > HIGH) {
        await new Promise((r) => l.dc.addEventListener("bufferedamountlow", r, { once: true }));
        continue;
      }
      if (RATE > 0) {
        const allowed = ((nowMs() - t0) / 1000) * (RATE / 8);
        if (l.sent > allowed) {
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
      }
      l.dc.send(payload);
      l.sent += CHUNK;
    }
    clearInterval(timer);
  }
  setInterval(() => {
    stats.samples.push({ t: nowMs(), sent: [...links.values()].map((l) => l.sent - l.dc.bufferedAmount) });
  }, 500);
} else {
  const pc = new RTCPeerConnection();
  const send = signalBus(async (m) => {
    if (m.to !== id) return;
    if (m.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      send({ type: "answer", from: id, sdp: pc.localDescription.sdp });
    }
    if (m.type === "ice" && m.cand) await pc.addIceCandidate(m.cand);
  });
  pc.onicecandidate = (e) => send({ type: "ice", from: id, cand: e.candidate?.toJSON() ?? null });
  pc.ondatachannel = (e) => {
    e.channel.binaryType = "arraybuffer";
    e.channel.onmessage = (ev) => (stats.received += ev.data.byteLength);
  };
  setInterval(() => stats.samples.push({ t: nowMs(), received: stats.received }), 500);
  send({ type: "hello", from: id });
}
