/* eslint-disable -- T-140 實驗原型 */
// node scan-hevc-gop.mjs <ffmpeg 路徑> <UTF-8 片源清單，每行一路徑>
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { once } from "node:events";

const [ffmpeg, manifest] = process.argv.slice(2);
if (!ffmpeg || !manifest) throw new Error("請提供 FFmpeg 路徑及片源清單");
const files = (await readFile(manifest, "utf8"))
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter(Boolean);

async function runFfmpeg(args, onData) {
  const process = spawn(ffmpeg, ["-hide_banner", "-nostdin", ...args], {
    windowsHide: true,
  });
  const exit = once(process, "close");
  let stderr = "";
  process.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-65536);
  });
  for await (const chunk of process.stdout) onData?.(chunk);
  const [code] = await exit;
  return { code, stderr };
}

async function probe(file) {
  const { stderr } = await runFfmpeg(["-i", file]);
  return /^\s*Stream #0:\d+.*?\bVideo: (\w+).*$/m.exec(stderr)?.[1] ?? null;
}

function countPictures() {
  const counts = {
    idr: 0,
    cra: 0,
    bla: 0,
    rasl: 0,
    radl: 0,
    craWithLeading: 0,
    idrWithLeading: 0,
    blaWithLeading: 0,
    orphanLeading: 0,
  };
  let zeros = 0,
    headerBytes = 0,
    nalType,
    irap,
    hasLeading;
  function read(chunk) {
    for (const byte of chunk) {
      if (headerBytes > 0) {
        if (headerBytes === 3) nalType = (byte >> 1) & 63;
        // first_slice_segment_in_pic_flag 只在同一張畫面的第一個 slice 為 1。
        if (headerBytes === 1 && byte & 128) {
          if (nalType >= 16 && nalType <= 21) {
            irap = nalType === 21 ? "cra" : nalType >= 19 ? "idr" : "bla";
            counts[irap]++;
            hasLeading = false;
          } else if (nalType >= 6 && nalType <= 9) {
            counts[nalType >= 8 ? "rasl" : "radl"]++;
            if (!irap) counts.orphanLeading++;
            else if (!hasLeading) {
              counts[irap + "WithLeading"]++;
              hasLeading = true;
            }
          }
        }
        headerBytes--;
        continue;
      }
      if (byte === 1 && zeros >= 2) headerBytes = 3;
      zeros = byte === 0 ? zeros + 1 : 0;
    }
  }
  return { counts, read };
}

const results = [],
  unreadable = [];
let otherCodec = 0;
for (const file of files) {
  const name = basename(file);
  const codec = await probe(file);
  if (codec !== "hevc") {
    if (codec) otherCodec++;
    else unreadable.push(name);
    continue;
  }
  const { counts, read } = countPictures();
  // FFmpeg 依解碼順序拆出首個視訊軌，輸出僅含 IRAP 與前導影格的 Annex B。
  const { code } = await runFfmpeg(
    [
      "-loglevel",
      "error",
      "-xerror",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-bsf:v",
      "hevc_mp4toannexb,filter_units=pass_types=6-9|16-21",
      "-f",
      "hevc",
      "pipe:1",
    ],
    read,
  );
  const container = extname(name).slice(1).toLowerCase();
  if (code !== 0 || counts.idr + counts.cra + counts.bla === 0) {
    results.push({
      name,
      container,
      status: "error",
      reason: code ? "FFmpeg 退出碼 " + code : "找不到 IRAP",
    });
  } else {
    const cleanEntries =
      counts.idr +
      counts.cra +
      counts.bla -
      counts.idrWithLeading -
      counts.craWithLeading -
      counts.blaWithLeading;
    results.push({
      name,
      container,
      status: "ok",
      ...counts,
      cleanEntries,
      eligibleByGop: cleanEntries > 0,
    });
  }
  console.error(name + " " + JSON.stringify({ code, ...counts }));
}
console.log(
  JSON.stringify(
    { scopedFiles: files.length, otherCodec, unreadable, results },
    null,
    2,
  ),
);
