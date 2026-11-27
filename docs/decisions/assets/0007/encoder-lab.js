/* eslint-disable -- T-140 實驗原型 */
const $ = (selector) => document.querySelector(selector);
const say = (message) => {
  $("#status").textContent += message + "\n";
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const r1 = (value) =>
  Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

async function measure(result, run) {
  say(result.test + "…");
  try {
    await window.labEncoderEvidence?.("begin");
    await run();
  } catch (error) {
    Object.assign(result, { status: "error", error: String(error) });
  }
  try {
    const evidence = await window.labEncoderEvidence?.("end");
    if (evidence) result.encoderDiagnostics = evidence;
    if (result.test.startsWith("webcodecs-") && evidence?.implementation) {
      result.encoderImplementation = evidence.implementation;
      result.powerEfficientEncoder = evidence.hardwareAccelerated;
    }
  } catch (error) {
    result.encoderDiagnosticsError = String(error);
  }
  if (result.status !== "ok") say("  " + (result.reason ?? result.error));
  return result;
}

function getTests(bitrate) {
  const codecs = [];
  for (const latencyMode of ["quality", "realtime"]) {
    for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"]) {
      for (const [bitrateMode, quantizer] of [
        ["variable", null],
        ["constant", null],
        ["quantizer", 22],
        ["quantizer", 26],
      ]) {
        const suffix = quantizer == null ? bitrateMode : "qp" + quantizer;
        codecs.push({
          test: ["webcodecs", latencyMode, hardwareAcceleration, suffix].join(
            "-",
          ),
          latencyMode,
          hardwareAcceleration,
          bitrateMode,
          quantizer,
          targetKbps: quantizer == null ? bitrate / 1000 : null,
        });
      }
    }
  }
  const rtc = [
    ["42001f", false],
    ["42e01f", false],
    ["42001f", true],
  ].map(([profile, boost]) => ({
    test: "webrtc-" + profile + (boost ? "-boost" : ""),
    profile,
    boost,
    targetKbps: bitrate / 1000,
    qpMethod: rtcQpMethod,
  }));
  return { codecs, rtc };
}

$("#run").onclick = async () => {
  const file = $("#file").files[0];
  if (!file) return alert("請先選一支影片");
  const settings = {
    height: Number($("#height").value),
    bitrate: Number($("#br").value) * 1e6,
    wcs: Number($("#wcs").value),
    rtcs: Number($("#rtcs").value),
  };
  if (
    !Number.isInteger(settings.wcs) ||
    settings.wcs < 1 ||
    !Number.isInteger(settings.rtcs) ||
    settings.rtcs < 3
  ) {
    return alert("WebCodecs 至少 1 秒、WebRTC 至少 3 秒，秒數請填整數");
  }
  window.labDone = null;
  $("#run").disabled = true;
  $("#status").textContent = "";
  const gl = document.createElement("canvas").getContext("webgl");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  const out = {
    page: "T-140 encoder-lab v3",
    at: new Date().toISOString(),
    ua: navigator.userAgent,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
    file: { name: file.name, mb: r1(file.size / 1e6) },
    settings,
    results: [],
  };
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  const show = () => {
    $("#out").value = JSON.stringify(out, null, 1);
  };
  const tests = getTests(settings.bitrate);
  let permissionStream, source;
  try {
    const { stream, ...permission } = await requestRtcPermission();
    permissionStream = stream;
    out.permission = permission;
    source = await openSource(file, settings.wcs);
    Object.assign(out.file, source.fileInfo);
    out.sourceStartSeconds = source.start;
    for (const result of tests.codecs) {
      out.results.push(
        await measure(result, () => webcodecs(source, settings, result)),
      );
      show();
    }
    for (const result of tests.rtc) {
      if (permission.status !== "granted") {
        result.status = "skipped";
        result.reason =
          permission.status === "denied"
            ? "因權限被拒而未跑"
            : "無法取得麥克風或鏡頭，未跑";
      } else {
        await measure(result, () => webrtc(file, settings, source, result));
      }
      out.results.push(result);
      show();
    }
    say("完成。可複製 JSON。");
  } catch (error) {
    out.error = String(error);
    if (out.permission?.status === "denied") {
      for (const result of tests.rtc.filter(
        (test) => !out.results.includes(test),
      )) {
        out.results.push({
          ...result,
          status: "skipped",
          reason: "因權限被拒而未跑",
        });
      }
    }
    say("錯誤：" + error);
  } finally {
    source?.input.dispose();
    permissionStream?.getTracks().forEach((track) => track.stop());
    show();
    $("#run").disabled = false;
    window.labDone = out;
  }
};
$("#copy").onclick = async () => {
  await navigator.clipboard.writeText($("#out").value);
  say("已複製");
};
