/* eslint-disable -- T-140 實驗原型 */
async function openSource(file, requestedSeconds) {
  const MB =
    await import("https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs");
  const input = new MB.Input({
    source: new MB.BlobSource(file),
    formats: MB.ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("找不到影像軌");
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error("無法取得解碼設定");
    const duration = await input.computeDuration();
    const sink = new MB.EncodedPacketSink(track);
    const start = Math.min(30, Math.max(0, duration - requestedSeconds - 1));
    const first =
      (await sink.getKeyPacket(start)) ?? (await sink.getFirstPacket());
    if (!first) throw new Error("影像軌沒有封包");
    const end = start + requestedSeconds;
    // 多送一個 GOP 的解碼相依封包，輸出以呈現時間裁切。
    const beforeEnd = await sink.getKeyPacket(end, { metadataOnly: true });
    const afterEnd =
      beforeEnd &&
      (await sink.getNextKeyPacket(beforeEnd, { metadataOnly: true }));
    const stats = await track.computePacketStats(240);
    return {
      input,
      sink,
      first,
      afterEnd,
      decoderConfig,
      start,
      end,
      fps: stats.averagePacketRate,
      fileInfo: {
        format: (await input.getFormat()).name,
        codec: decoderConfig.codec,
        w: track.displayWidth,
        h: track.displayHeight,
        fps: r1(stats.averagePacketRate),
        duration: r1(duration),
        mbps: r1((file.size * 8) / duration / 1e6),
        tenBit: /^(hev1|hvc1)\.2\./.test(decoderConfig.codec),
      },
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

const webcodecsQpMethod =
  "每張取 H.264 Annex B 最後一個 slice 的基本 luma QP（26 + pic_init_qp_minus26 + slice_qp_delta），只平均可解析影格，不含 macroblock QP 調整";

async function webcodecs(source, settings, result) {
  const { height, bitrate } = settings;
  const { latencyMode, hardwareAcceleration, bitrateMode, quantizer } = result;
  const { fps, fileInfo, start, end } = source;
  const width = Math.round((fileInfo.w * height) / fileInfo.h / 2) * 2;
  const level =
    height > 1440
      ? fps > 30.1
        ? "34"
        : "33"
      : height > 1080
        ? fps > 30.1
          ? "33"
          : "32"
        : fps > 30.1
          ? "2a"
          : "28";
  const config = {
    codec: "avc1.6400" + level,
    width,
    height,
    framerate: fps,
    bitrateMode,
    latencyMode,
    hardwareAcceleration,
    avc: { format: "annexb" },
  };
  if (bitrateMode !== "quantizer") config.bitrate = bitrate;
  Object.assign(result, {
    requestedConfig: config,
    out: width + "x" + height,
    qpMethod: webcodecsQpMethod,
    encoderImplementation: null,
    powerEfficientEncoder: null,
  });

  const support = await VideoEncoder.isConfigSupported(config).catch(
    (error) => ({ supported: false, reason: String(error) }),
  );
  result.supported =
    support.supported && support.config?.bitrateMode === bitrateMode;
  if (!result.supported) {
    result.status = "unsupported";
    result.reason =
      support.reason ??
      (support.supported
        ? "Chrome 未在 isConfigSupported 回傳指定的 bitrateMode"
        : "VideoEncoder.isConfigSupported 回傳 supported: false");
    return;
  }
  result.config = support.config;

  const qpReader = createQpReader();
  const chunks = [],
    qs = [];
  let maxTs = -Infinity,
    minTs = Infinity,
    maxEnd = -Infinity;
  let keys = 0,
    reordered = 0,
    submitted = 0,
    inputFirstUs,
    inputEndUs,
    fault;
  let decoder, encoder;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    encoder = new VideoEncoder({
      output(chunk, metadata) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const qp = qpReader(data);
        if (qp != null) qs.push(qp);
        if (chunk.type === "key") keys++;
        if (chunk.timestamp < maxTs) reordered++;
        maxTs = Math.max(maxTs, chunk.timestamp);
        minTs = Math.min(minTs, chunk.timestamp);
        maxEnd = Math.max(
          maxEnd,
          chunk.timestamp + (chunk.duration || 1e6 / fps),
        );
        chunks.push({ us: chunk.timestamp, bytes: chunk.byteLength });
        result.outputCodec =
          metadata?.decoderConfig?.codec ?? result.outputCodec;
      },
      error(error) {
        fault ??= error;
      },
    });
    encoder.configure(config);
    let lastKey = -Infinity;
    decoder = new VideoDecoder({
      output(frame) {
        try {
          if (frame.timestamp < start * 1e6 || frame.timestamp >= end * 1e6)
            return;
          ctx.drawImage(frame, 0, 0, width, height);
          const params = {
            timestamp: frame.timestamp,
            duration: frame.duration ?? undefined,
          };
          const scaled = new VideoFrame(canvas, params);
          try {
            const keyFrame = frame.timestamp - lastKey >= 2e6;
            if (keyFrame) lastKey = frame.timestamp;
            const options =
              quantizer == null
                ? { keyFrame }
                : { keyFrame, avc: { quantizer } };
            encoder.encode(scaled, options);
            submitted++;
            inputFirstUs ??= frame.timestamp;
            inputEndUs = frame.timestamp + (frame.duration || 1e6 / fps);
          } finally {
            scaled.close();
          }
        } catch (error) {
          fault ??= error;
        } finally {
          frame.close();
        }
      },
      error(error) {
        fault ??= error;
      },
    });
    // 8K AVC 在這台 Windows 上無法強制硬解，交由 Chrome 選擇可用的解碼器。
    decoder.configure(source.decoderConfig);
    const started = performance.now();
    for await (const packet of source.sink.packets(
      source.first,
      source.afterEnd ?? undefined,
    )) {
      while (
        !fault &&
        (decoder.decodeQueueSize > 6 || encoder.encodeQueueSize > 6)
      )
        await sleep(1);
      if (fault) throw fault;
      decoder.decode(packet.toEncodedVideoChunk());
    }
    await decoder.flush();
    if (fault) throw fault;
    await encoder.flush();
    if (fault) throw fault;
    const wall = (performance.now() - started) / 1000;
    if (chunks.length === 0) throw new Error("編碼器沒有輸出影格");
    const outputMedia = (maxEnd - minTs) / 1e6;
    const inputMedia = (inputEndUs - inputFirstUs) / 1e6;
    const bytes = chunks.reduce((total, chunk) => total + chunk.bytes, 0);
    const buckets = Array(Math.ceil(outputMedia)).fill(0);
    for (const chunk of chunks)
      buckets[Math.floor((chunk.us - minTs) / 1e6)] += chunk.bytes;
    qs.sort((a, b) => a - b);
    Object.assign(result, {
      status: "ok",
      frames: chunks.length,
      framesSubmitted: submitted,
      droppedFrames: submitted - chunks.length,
      wallS: r1(wall),
      mediaSeconds: r1(outputMedia),
      encodeFps: r1(chunks.length / wall),
      speedX: r1(inputMedia / wall),
      kbps: Math.round((bytes * 8) / outputMedia / 1000),
      qpFrames: qs.length,
      avgQp: r1(qs.reduce((a, b) => a + b, 0) / qs.length),
      qpP10: qs[Math.floor(qs.length * 0.1)] ?? null,
      qpP90: qs[Math.floor(qs.length * 0.9)] ?? null,
      keyFrames: keys,
      outOfOrderChunks: reordered,
      bitrateTimeline: {
        clock: "output-media",
        lastBinSeconds: outputMedia - (buckets.length - 1),
        kbps: buckets.map((size, second) =>
          Math.round((size * 8) / Math.min(1, outputMedia - second) / 1000),
        ),
      },
    });
  } finally {
    if (decoder && decoder.state !== "closed") decoder.close();
    if (encoder && encoder.state !== "closed") encoder.close();
  }
}
