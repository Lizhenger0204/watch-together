/* eslint-disable -- T-140 實驗原型 */
const rtcQpMethod =
  "穩態區間 outbound-rtp 的 ΔqpSum ÷ ΔframesEncoded（Chrome 每張畫面的 QP 累計值）";

async function requestRtcPermission() {
  const attempts = [];
  if (!navigator.mediaDevices?.getUserMedia)
    return { status: "unavailable", attempts };
  for (const kind of ["audio", "video"]) {
    say(
      kind === "audio"
        ? "請允許麥克風以量測 WebRTC 編碼器…"
        : "嘗試改用鏡頭權限…",
    );
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        [kind]: true,
      });
      return { status: "granted", kind, stream, attempts };
    } catch (error) {
      attempts.push({ kind, name: error.name, message: error.message });
    }
  }
  return {
    status: attempts.some(({ name }) => name === "NotAllowedError")
      ? "denied"
      : "unavailable",
    attempts,
  };
}

function to8bit(track, width, height, signal) {
  const output = new MediaStreamTrackGenerator({ kind: "video" });
  const canvas = new OffscreenCanvas(width & ~1, height & ~1);
  const ctx = canvas.getContext("2d", { alpha: false });
  const processor = new MediaStreamTrackProcessor({ track });
  processor.readable
    .pipeThrough(
      new TransformStream({
        transform(frame, controller) {
          try {
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            controller.enqueue(
              new VideoFrame(canvas, { timestamp: frame.timestamp }),
            );
          } finally {
            frame.close();
          }
        },
      }),
    )
    .pipeTo(output.writable, { signal })
    .catch(() => {});
  return output;
}

function forwardIce(from, to) {
  const pending = [];
  from.onicecandidate = ({ candidate }) => {
    if (!candidate || to.signalingState === "closed") return;
    if (!to.remoteDescription) pending.push(candidate);
    else void to.addIceCandidate(candidate).catch(console.error);
  };
  return () =>
    Promise.all(
      pending.splice(0).map((candidate) => to.addIceCandidate(candidate)),
    );
}

async function rtcSample(pc) {
  const stats = await pc.getStats();
  const out = [...stats.values()].find(
    (entry) =>
      entry.type === "outbound-rtp" &&
      entry.kind === "video" &&
      stats.get(entry.codecId)?.mimeType !== "video/rtx",
  );
  if (!out) return null;
  const pair = stats.get(stats.get(out.transportId)?.selectedCandidatePairId);
  return {
    timestamp: out.timestamp,
    bytes: out.bytesSent,
    frames: out.framesEncoded,
    qpSum: out.qpSum,
    impl: out.encoderImplementation,
    pe: out.powerEfficientEncoder,
    width: out.frameWidth,
    height: out.frameHeight,
    fps: out.framesPerSecond,
    limitation: out.qualityLimitationReason,
    target: out.targetBitrate,
    avail: pair?.availableOutgoingBitrate,
    codec: stats.get(out.codecId)?.mimeType,
    fmtp: stats.get(out.codecId)?.sdpFmtpLine,
  };
}

async function webrtc(file, settings, source, result) {
  const { height, bitrate, rtcs } = settings;
  const { profile, boost } = result;
  const original = $("#v"),
    url = URL.createObjectURL(file);
  const senderPc = new RTCPeerConnection(),
    receiverPc = new RTCPeerConnection();
  const toReceiver = forwardIce(senderPc, receiverPc),
    toSender = forwardIce(receiverPc, senderPc);
  const abort = new AbortController();
  let stream, generated;
  try {
    original.src = url;
    original.loop = true;
    // loadeddata 可確認此容器真的能經由 HTMLVideoElement 解碼。
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("等待影片首幀逾時")),
        12000,
      );
      original.onloadeddata = () => {
        clearTimeout(timeout);
        resolve();
      };
      original.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(original.error?.message || "Chrome 無法播放片源"));
      };
    });
    original.currentTime = source.start;
    await original.play();
    stream = original.captureStream();
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("captureStream 未提供影像軌");
    const scale = Math.max(1, original.videoHeight / height);
    // BUG-004：WebRTC 之前先把 Main 10 解碼畫面送過 8-bit canvas。
    if (source.fileInfo.tenBit) {
      generated = to8bit(
        track,
        original.videoWidth,
        original.videoHeight,
        abort.signal,
      );
    }
    const sendTrack = generated ?? track;
    sendTrack.contentHint = "motion";
    const maxBitrate = bitrate * (boost ? 1.5 : 1);
    const transceiver = senderPc.addTransceiver(sendTrack, {
      direction: "sendonly",
      sendEncodings: [
        { maxBitrate, scaleResolutionDownBy: scale, maxFramerate: 30 },
      ],
    });
    const codecs = RTCRtpSender.getCapabilities("video").codecs.filter(
      (codec) =>
        codec.mimeType === "video/H264" &&
        /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(codec.sdpFmtpLine ?? "") &&
        (codec.sdpFmtpLine ?? "").includes("profile-level-id=" + profile),
    );
    if (!codecs.length)
      throw new Error("Chrome 未提供指定的 H.264 profile " + profile);
    transceiver.setCodecPreferences(codecs);
    await senderPc.setLocalDescription();
    await receiverPc.setRemoteDescription(senderPc.localDescription);
    await toReceiver();
    await receiverPc.setLocalDescription();
    await senderPc.setRemoteDescription(receiverPc.localDescription);
    await toSender();
    const params = transceiver.sender.getParameters();
    params.degradationPreference =
      height > 1080 ? "maintain-resolution" : "maintain-framerate";
    await transceiver.sender.setParameters(params);
    Object.assign(result, {
      maxBitrate,
      scaleResolutionDownBy: scale,
      maxFramerate: 30,
    });

    const started = performance.now(),
      samples = [await rtcSample(senderPc)];
    for (let second = 1; second <= rtcs; second++) {
      await sleep(Math.max(0, started + second * 1000 - performance.now()));
      samples.push(await rtcSample(senderPc));
      if (second % 10 === 0)
        say(result.test + " " + second + "/" + rtcs + " 秒");
    }
    const warm = Math.min(20, Math.floor(rtcs / 3));
    const first = samples.slice(warm).find((sample) => sample?.frames > 0);
    const last = samples.at(-1);
    if (!first || !last || last.frames <= first.frames)
      throw new Error("穩態區間沒有新增編碼影格");
    const seconds = (last.timestamp - first.timestamp) / 1000;
    const qpFrames = last.frames - first.frames;
    const limitation = {};
    for (const sample of samples.slice(warm)) {
      if (sample?.limitation)
        limitation[sample.limitation] =
          (limitation[sample.limitation] ?? 0) + 1;
    }
    Object.assign(result, {
      status: "ok",
      encoderImplementation: last.impl ?? null,
      powerEfficientEncoder: last.pe ?? null,
      codec: last.codec,
      sdpFmtpLine: last.fmtp,
      resolution: last.width + "x" + last.height,
      kbps: Math.round(((last.bytes - first.bytes) * 8) / seconds / 1000),
      avgQp: r1((last.qpSum - first.qpSum) / qpFrames),
      encodeFps: r1(qpFrames / seconds),
      steadySeconds: r1(seconds),
      warmupSeconds: warm,
      targetBitrateKbps:
        last.target == null ? null : Math.round(last.target / 1000),
      availableOutgoingKbps:
        last.avail == null ? null : Math.round(last.avail / 1000),
      qualityLimitation: limitation,
      bitrateTimeline: {
        clock: "stats-wall",
        columns: ["seconds", "kbps"],
        bins: samples.slice(1).map((sample, second) => {
          const previous = samples[second];
          const seconds =
            sample && previous
              ? (sample.timestamp - previous.timestamp) / 1000
              : null;
          const kbps =
            seconds > 0
              ? Math.round(
                  ((sample.bytes - previous.bytes) * 8) / seconds / 1000,
                )
              : null;
          return [seconds, kbps];
        }),
      },
      observations: [
        ...new Set(
          samples
            .filter(Boolean)
            .map(({ impl, pe, width, height }) =>
              JSON.stringify({ impl, pe, width, height }),
            ),
        ),
      ].map((sample) => JSON.parse(sample)),
    });
    if (window.labRtcDump) {
      try {
        await window.labRtcDump(result.test);
      } catch (error) {
        result.dumpError = String(error);
      }
    }
  } finally {
    senderPc.close();
    receiverPc.close();
    abort.abort();
    generated?.stop();
    stream?.getTracks().forEach((track) => track.stop());
    original.onloadeddata = original.onerror = null;
    original.pause();
    original.removeAttribute("src");
    original.load();
    URL.revokeObjectURL(url);
  }
}
