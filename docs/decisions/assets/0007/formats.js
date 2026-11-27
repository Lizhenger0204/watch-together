/* eslint-disable -- T-140 實驗原型（瀏覽器／Node 腳本），不是正式程式碼 */
// T-140 原型：片源能不能走「原片直送」。拆檔 → fMP4 → MSE，播 1.5 秒看畫面是否前進。不是正式程式碼。
import { describeTrack, initSegment, mediaSegment } from "./fmp4.js";

export async function probe(url, mbUrl) {
  const MB = await import(mbUrl);
  const blob = await (await fetch(url)).blob();
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const out = { url, format: (await input.getFormat()).name };
  const vt = await input.getPrimaryVideoTrack();
  const at = await input.getPrimaryAudioTrack();
  const vcfg = await vt.getDecoderConfig();
  const acfg = at ? await at.getDecoderConfig() : null;
  out.videoCodec = vcfg?.codec ?? null;
  out.audioCodec = at ? ((await at.getCodecParameterString()) ?? at.codec) : null;
  const tracks = [describeTrack("video", vcfg, 1)];
  if (acfg) tracks.push(describeTrack("audio", acfg, 2));
  out.mse = Object.fromEntries(tracks.map((t) => [t.kind, MediaSource.isTypeSupported(t.mime)]));
  out.webcodecs = {
    video: (await VideoDecoder.isConfigSupported(vcfg)).supported,
    audio: acfg ? (await AudioDecoder.isConfigSupported(acfg)).supported : null,
  };
  const usable = tracks.filter((t) => out.mse[t.kind]);
  const v = document.createElement("video");
  v.muted = true;
  document.body.append(v);
  const ms = new MediaSource();
  v.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
  const sbs = usable.map((t) => ms.addSourceBuffer(t.mime));
  const append = (sb, bytes) =>
    new Promise((resolve) => {
      sb.addEventListener("updateend", () => resolve(true), { once: true });
      sb.addEventListener("error", () => resolve(false), { once: true });
      sb.appendBuffer(bytes);
    });
  out.appended = {};
  for (const [i, t] of usable.entries()) {
    const sink = new MB.EncodedPacketSink(t.kind === "video" ? vt : at);
    const samples = [];
    for await (const p of sink.packets()) {
      if (p.timestamp > 3) break;
      samples.push({ pts: p.timestamp, duration: p.duration, key: p.type === "key", data: p.data });
    }
    const ok1 = await append(sbs[i], initSegment(t));
    const ok2 = ok1 && (await append(sbs[i], mediaSegment({ trackId: t.trackId, timescale: t.timescale, seq: 1, samples })));
    out.appended[t.kind] = ok2;
  }
  if (usable.some((t) => t.kind === "video") && out.appended.video) {
    await v.play().catch((e) => (out.playError = String(e)));
    await new Promise((r) => setTimeout(r, 1500));
    out.playedTo = +v.currentTime.toFixed(2);
    out.frames = v.getVideoPlaybackQuality().totalVideoFrames;
  }
  out.error = v.error?.message ?? null;
  v.remove();
  return out;
}
