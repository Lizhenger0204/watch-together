import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEVC_NAL_SPS,
  HEVC_PROFILE_MAIN,
  HEVC_PROFILE_MAIN_10,
  inspectSampleParameterSets,
  rbspToEbsp,
} from "./hevc-bitstream";
import { buildZeroCopyHevcProfileFix, inspectHevcProfile } from "./hevc-header";

const FIXTURES_DIR = resolve(process.cwd(), "e2e/fixtures");

function u32(val: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, val, false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function mp4Box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function ebmlVint(value: number): Uint8Array<ArrayBuffer> {
  if (value < 0x7f) return new Uint8Array([0x80 | value]);
  if (value < 0x3fff) {
    return new Uint8Array([0x40 | (value >> 8), value & 0xff]);
  }
  return new Uint8Array([
    0x20 | (value >> 16),
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

function ebmlEl(
  idBytes: number[],
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array(idBytes), ebmlVint(payload.length), payload);
}

function makeSyntheticSps(options?: {
  maxSubLayersMinus1?: number;
  subLayerProfileIdc?: number;
}) {
  const { maxSubLayersMinus1 = 0, subLayerProfileIdc } = options ?? {};
  const bits: number[] = [];
  const pushBits = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  const pushUE = (val: number) => {
    const code = val + 1;
    const len = Math.floor(Math.log2(code));
    for (let i = 0; i < len; i += 1) bits.push(0);
    pushBits(code, len + 1);
  };
  pushBits(0, 4);
  pushBits(maxSubLayersMinus1, 3);
  pushBits(1, 1);
  pushBits(0, 2);
  pushBits(0, 1);
  pushBits(HEVC_PROFILE_MAIN_10, 5);
  pushBits(0x20, 8);
  for (let i = 0; i < 9; i += 1) pushBits(0, 8);
  pushBits(93, 8);
  if (maxSubLayersMinus1 > 0) {
    for (let i = 0; i < maxSubLayersMinus1; i += 1) {
      pushBits(subLayerProfileIdc !== undefined ? 1 : 0, 1);
      pushBits(0, 1);
    }
    pushBits(0, (8 - maxSubLayersMinus1) * 2);
    for (let i = 0; i < maxSubLayersMinus1; i += 1) {
      if (subLayerProfileIdc !== undefined) {
        pushBits(0, 2);
        pushBits(0, 1);
        pushBits(subLayerProfileIdc, 5);
        for (let b = 0; b < 10; b += 1) pushBits(0, 8);
      }
    }
  }
  pushUE(0);
  pushUE(1);
  pushUE(160);
  pushUE(96);
  pushBits(0, 1);
  pushUE(0);
  pushUE(0);
  pushBits(1, 1);
  while (bits.length % 8 !== 0) bits.push(0);
  const rbsp = new Uint8Array(bits.length / 8);
  for (let i = 0; i < rbsp.length; i += 1) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i * 8 + j]!;
    rbsp[i] = b;
  }
  const ebsp = rbspToEbsp(rbsp);
  const out = new Uint8Array(2 + ebsp.length);
  out[0] = (HEVC_NAL_SPS << 1) & 0x7e;
  out[1] = 0x01;
  out.set(ebsp, 2);
  return out;
}

function makeHvccWithSps(sps: Uint8Array) {
  const out = new Uint8Array(23 + 5 + sps.length);
  out[0] = 1;
  out[1] = HEVC_PROFILE_MAIN_10;
  out[2] = 0x20;
  out[12] = 93;
  out[16] = 0xfd;
  out[17] = 0xf8;
  out[18] = 0xf8;
  out[21] = 0x03;
  out[22] = 1;
  out[23] = 0x80 | HEVC_NAL_SPS;
  out[24] = 0;
  out[25] = 1;
  out[26] = (sps.length >> 8) & 0xff;
  out[27] = sps.length & 0xff;
  out.set(sps, 28);
  return out;
}

function lenPrefix(nalu: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(u32(nalu.length), nalu);
}

describe("HEVC container regressions (R4 review fixes)", () => {
  it("refuses hev1 MP4 when a 64 KiB leading SEI pushes SPS (or Main 10 sub-layer SPS) past the probe window", async () => {
    const sps = makeSyntheticSps();
    const subLayerSps = makeSyntheticSps({
      maxSubLayersMinus1: 1,
      subLayerProfileIdc: HEVC_PROFILE_MAIN_10,
    });
    const hvcc = makeHvccWithSps(sps);
    const vcl = new Uint8Array([0x26, 0x01, 0xaa, 0xbb]);

    // 構造剛好填滿 65,536 bytes 的前置 PREFIX_SEI（NAL type 39: 0x4e 0x01），使後方 SPS 落在 64 KiB 之外
    const exact64KiBSei = new Uint8Array(65_536 - 4);
    exact64KiBSei[0] = (39 << 1) & 0x7e;
    exact64KiBSei[1] = 0x01;
    exact64KiBSei.fill(0x55, 2);

    const buildHev1WithHiddenSps = (hiddenSps: Uint8Array) => {
      // 第 1 幀乾淨（讓 inspect 順利確診 mismatch），第 2 幀前置 SEI 剛好塞滿 64 KiB、後面藏 SPS
      const s1 = lenPrefix(vcl);
      const s2 = concat(
        lenPrefix(exact64KiBSei),
        lenPrefix(hiddenSps),
        lenPrefix(vcl),
      );
      const hev1 = mp4Box(
        "hev1",
        concat(new Uint8Array(78), mp4Box("hvcC", hvcc)),
      );
      const stsd = mp4Box("stsd", concat(u32(0), u32(1), hev1));
      const stsc = mp4Box(
        "stsc",
        concat(u32(0), u32(1), u32(1), u32(2), u32(1)),
      );
      const stsz = mp4Box(
        "stsz",
        concat(u32(0), u32(0), u32(2), u32(s1.length), u32(s2.length)),
      );
      const stss = mp4Box("stss", concat(u32(0), u32(1), u32(1)));
      const ftyp = mp4Box(
        "ftyp",
        new TextEncoder().encode("isom\0\0\x02\0isom"),
      );
      const mdat = mp4Box("mdat", concat(s1, s2));
      const make = (off: number) => {
        const stco = mp4Box("stco", concat(u32(0), u32(1), u32(off)));
        const moov = mp4Box(
          "moov",
          mp4Box(
            "trak",
            mp4Box(
              "mdia",
              mp4Box(
                "minf",
                mp4Box("stbl", concat(stsd, stsc, stsz, stss, stco)),
              ),
            ),
          ),
        );
        return { moov, bytes: concat(ftyp, moov, mdat) };
      };
      const mdatStart = ftyp.length + make(0).moov.length + 8;
      return new Blob([make(mdatStart).bytes], { type: "video/mp4" });
    };

    for (const hiddenSps of [sps, subLayerSps]) {
      const blob = buildHev1WithHiddenSps(hiddenSps);
      const insp = await inspectHevcProfile(blob);
      expect(insp?.info.mismatchMain10On8Bit).toBe(true);
      const fix = await buildZeroCopyHevcProfileFix(blob, insp!);
      expect(fix).toEqual({
        ok: false,
        reason: "truncated-inband-parameter-set",
      });
    }
  });

  it("scans small MKV Clusters past 64 top-level Void elements, probes single Cue on large MKV, and rejects unreadable Cue targets", async () => {
    const malformedMkv = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-malformed-aac.mkv"),
    );
    const origInsp = await inspectHevcProfile(
      new Blob([malformedMkv], { type: "video/x-matroska" }),
    );
    if (!origInsp || origInsp.container !== "mkv")
      throw new Error("expected mkv");

    const sps = makeSyntheticSps();
    const vcl = new Uint8Array([0x26, 0x01, 0xde, 0xad]);
    const ebmlHeader = ebmlEl(
      [0x1a, 0x45, 0xdf, 0xa3],
      new Uint8Array([0x42, 0x86, 0x81, 0x01]),
    );
    const tracks = ebmlEl(
      [0x16, 0x54, 0xae, 0x6b],
      ebmlEl(
        [0xae],
        concat(
          ebmlEl([0xd7], new Uint8Array([1])),
          ebmlEl([0x83], new Uint8Array([1])),
          ebmlEl([0x86], new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
          ebmlEl([0x63, 0xa2], origInsp.codecPrivateBytes),
        ),
      ),
    );
    const makeBlock = (body: Uint8Array) =>
      ebmlEl([0xa3], concat(new Uint8Array([0x81, 0x00, 0x00, 0x80]), body));
    const tc = (n: number) => ebmlEl([0xe7], new Uint8Array([n]));
    const clusterWithSps = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tc(0), makeBlock(concat(lenPrefix(sps), lenPrefix(vcl)))),
    );

    // 1. 小型 MKV 在 Tracks 後放 65 個 Void，使首個 Cluster 超過 64 步走訪上限 → 仍須走訪並修補
    const voids = Array.from({ length: 65 }, () =>
      ebmlEl([0xec], new Uint8Array([0x00])),
    );
    const manyVoidMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl(
            [0x18, 0x53, 0x80, 0x67],
            concat(tracks, ...voids, clusterWithSps),
          ),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const voidInsp = await inspectHevcProfile(manyVoidMkv);
    expect(voidInsp?.container).toBe("mkv");
    if (voidInsp?.container === "mkv") {
      expect(voidInsp.firstClusterOffset).toBeNull();
    }
    const voidFix = await buildZeroCopyHevcProfileFix(manyVoidMkv, voidInsp!);
    expect(voidFix.ok).toBe(true);
    if (!voidFix.ok) return;
    const voidOut = new Uint8Array(await voidFix.blob.arrayBuffer());
    const found: number[] = [];
    for (let i = 0; i + 4 + sps.length <= voidOut.length; i += 1) {
      if (
        voidOut[i] === 0 &&
        voidOut[i + 1] === 0 &&
        voidOut[i + 2] === 0 &&
        voidOut[i + 3] === sps.length &&
        ((voidOut[i + 4]! >> 1) & 0x3f) === HEVC_NAL_SPS
      ) {
        const r = inspectSampleParameterSets(
          voidOut.subarray(i, i + 4 + sps.length),
          4,
        );
        if (r.spsList[0]) found.push(r.spsList[0].generalProfileIdc);
      }
    }
    expect(found).toEqual([HEVC_PROFILE_MAIN]);

    // 2. 大型 MKV（> 4 MB）僅有 1 筆有效 Cue 指向含 SPS 的第二個 Cluster → 必須抽查並降級
    const cleanCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tc(0), makeBlock(lenPrefix(vcl))),
    );
    const u32be = (v: number) => u32(v);
    const makeSingleCue = (clusterPos: number) =>
      ebmlEl(
        [0x1c, 0x53, 0xbb, 0x6b],
        ebmlEl(
          [0xbb],
          ebmlEl(
            [0xb7],
            concat(
              ebmlEl([0xf7], new Uint8Array([1])),
              ebmlEl([0xf1], u32be(clusterPos)),
            ),
          ),
        ),
      );
    const dummyCueLen = makeSingleCue(0).length;
    const targetClusterPos = tracks.length + dummyCueLen + cleanCluster.length;
    const singleCue = makeSingleCue(targetClusterPos);
    const segHdrUnknown = new Uint8Array([
      0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    const largeSingleCueMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        singleCue,
        cleanCluster,
        clusterWithSps,
        new Uint8Array(4_500_000),
      ],
      { type: "video/x-matroska" },
    );
    const singleCueInsp = await inspectHevcProfile(largeSingleCueMkv);
    expect(singleCueInsp?.info.hasInBandParameterSets).toBe(true);
    const singleCueFix = await buildZeroCopyHevcProfileFix(
      largeSingleCueMkv,
      singleCueInsp!,
    );
    expect(singleCueFix).toEqual({
      ok: false,
      reason: "mkv-inband-unverified-coverage",
    });

    // 3. 大型 MKV 的唯一 Cue 指向無效位置 → 不可當成抽查乾淨，須回傳 mkv-probe-unreadable
    const brokenCue = makeSingleCue(999_999);
    const largeBrokenCueMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        brokenCue,
        cleanCluster,
        new Uint8Array(4_500_000),
      ],
      { type: "video/x-matroska" },
    );
    const brokenCueInsp = await inspectHevcProfile(largeBrokenCueMkv);
    expect(brokenCueInsp?.info.mismatchMain10On8Bit).toBe(true);
    const brokenCueFix = await buildZeroCopyHevcProfileFix(
      largeBrokenCueMkv,
      brokenCueInsp!,
    );
    expect(brokenCueFix).toEqual({
      ok: false,
      reason: "mkv-probe-unreadable",
    });
  });

  it("handles R5 MKV probe edge cases: mid-NAL cut on large MKV, 16 KiB SEI on small MKV, unreadable SeekHead Cues, CueRelativePosition overshoot, and >64 Voids on large MKV", async () => {
    const malformedMkv = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-malformed-aac.mkv"),
    );
    const origInsp = await inspectHevcProfile(
      new Blob([malformedMkv], { type: "video/x-matroska" }),
    );
    if (!origInsp || origInsp.container !== "mkv")
      throw new Error("expected mkv");

    const sps = makeSyntheticSps();
    const vcl = new Uint8Array([0x26, 0x01, 0xde, 0xad]);
    const ebmlHeader = ebmlEl(
      [0x1a, 0x45, 0xdf, 0xa3],
      new Uint8Array([0x42, 0x86, 0x81, 0x01]),
    );
    const tracks = ebmlEl(
      [0x16, 0x54, 0xae, 0x6b],
      ebmlEl(
        [0xae],
        concat(
          ebmlEl([0xd7], new Uint8Array([1])),
          ebmlEl([0x83], new Uint8Array([1])),
          ebmlEl([0x86], new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
          ebmlEl([0x63, 0xa2], origInsp.codecPrivateBytes),
        ),
      ),
    );
    const makeBlock = (body: Uint8Array) =>
      ebmlEl([0xa3], concat(new Uint8Array([0x81, 0x00, 0x00, 0x80]), body));
    const tc = (n: number) => ebmlEl([0xe7], new Uint8Array([n]));
    const segHdrUnknown = new Uint8Array([
      0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    const pad45MB = new Uint8Array(4_500_000);

    // R5-1：大型 MKV 的 16 KiB 探測視窗剛好切在第一個 SPS NAL 標頭第 1 byte（共 5 bytes）→ 不可放行修補
    const spsBlock = makeBlock(concat(lenPrefix(sps), lenPrefix(vcl)));
    const clusterHdrLen = 7; // 4-byte ID + 3-byte VINT
    const tcEl = tc(0);
    // 計算 Void 大小，使 16,384 byte 視窗剛好停在 spsBlock payload 的第 5 byte（4-byte len + 1 byte NAL hdr）
    const blockHdrLen = 1 + 1 + 4; // 0xa3 + 1-byte vint (<127) + track/ts/flags
    const voidHdrLen = 1 + 2; // 0xec + 2-byte vint (< 16383)
    const voidPayloadLen =
      16_384 - clusterHdrLen - tcEl.length - voidHdrLen - blockHdrLen - 5;
    const voidInCluster = ebmlEl([0xec], new Uint8Array(voidPayloadLen));
    const midCutCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, voidInCluster, spsBlock),
    );
    const midCutLargeMkv = new Blob(
      [ebmlHeader, segHdrUnknown, tracks, midCutCluster, pad45MB],
      { type: "video/x-matroska" },
    );
    const midCutInsp = await inspectHevcProfile(midCutLargeMkv);
    expect(midCutInsp?.info.mismatchMain10On8Bit).toBe(true);
    expect(
      await buildZeroCopyHevcProfileFix(midCutLargeMkv, midCutInsp!),
    ).toEqual({
      ok: false,
      reason: "mkv-probe-unreadable",
    });

    // R5-2：小型 MKV 的前置 SEI 剛好佔滿 16 KiB，後方完整接 SPS + VCL → 必須維持 mismatch=true 並修補成功
    const bigSei = new Uint8Array(16_300);
    bigSei[0] = (39 << 1) & 0x7e;
    bigSei[1] = 0x01;
    const smallSeiCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(
        tcEl,
        makeBlock(concat(lenPrefix(bigSei), lenPrefix(sps), lenPrefix(vcl))),
      ),
    );
    const smallSeiMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl([0x18, 0x53, 0x80, 0x67], concat(tracks, smallSeiCluster)),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const smallSeiInsp = await inspectHevcProfile(smallSeiMkv);
    expect(smallSeiInsp?.info.mismatchMain10On8Bit).toBe(true);
    const smallSeiFix = await buildZeroCopyHevcProfileFix(
      smallSeiMkv,
      smallSeiInsp!,
    );
    expect(smallSeiFix.ok).toBe(true);

    // R5-3a：大型 MKV 的 SeekHead 指向不可讀的 Cues → 必須拒絕（mkv-probe-unreadable）
    const cleanCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, makeBlock(lenPrefix(vcl))),
    );
    const badSeekHead = ebmlEl(
      [0x11, 0x4d, 0x9b, 0x74],
      ebmlEl(
        [0x4d, 0xbb],
        concat(
          ebmlEl([0x53, 0xab], new Uint8Array([0x1c, 0x53, 0xbb, 0x6b])),
          ebmlEl([0x53, 0xac], u32(1_234_567)),
        ),
      ),
    );
    const badCuesMkv = new Blob(
      [ebmlHeader, segHdrUnknown, badSeekHead, tracks, cleanCluster, pad45MB],
      { type: "video/x-matroska" },
    );
    const badCuesInsp = await inspectHevcProfile(badCuesMkv);
    expect(await buildZeroCopyHevcProfileFix(badCuesMkv, badCuesInsp!)).toEqual(
      {
        ok: false,
        reason: "mkv-probe-unreadable",
      },
    );

    // R5-3b：大型 MKV 的 CueRelativePosition 越出所屬 Cluster 讀到下一個乾淨 Cluster → 必須拒絕
    const spsCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, makeBlock(concat(lenPrefix(sps), lenPrefix(vcl)))),
    );
    // Cluster 1（spsCluster）後緊接 Cluster 2（cleanCluster），Cue 指向 Cluster 1 但 relativePosition 越過 Cluster 1 落到 Cluster 2 的 block
    const makeOvershootCue = (c1Pos: number, relPos: number) =>
      ebmlEl(
        [0x1c, 0x53, 0xbb, 0x6b],
        ebmlEl(
          [0xbb],
          ebmlEl(
            [0xb7],
            concat(
              ebmlEl([0xf7], new Uint8Array([1])),
              ebmlEl([0xf1], u32(c1Pos)),
              ebmlEl([0xf0], u32(relPos)),
            ),
          ),
        ),
      );
    const cueLen = makeOvershootCue(0, 0).length;
    const c1Pos = tracks.length + cueLen + cleanCluster.length;
    // 越過 spsCluster 本體＋cleanCluster 標頭＋tcEl，直接指進後方的乾淨 block
    const overshootRel = spsCluster.length + 5 + tcEl.length;
    const overshootMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        makeOvershootCue(c1Pos, overshootRel),
        cleanCluster,
        spsCluster,
        cleanCluster,
        pad45MB,
      ],
      { type: "video/x-matroska" },
    );
    const overshootInsp = await inspectHevcProfile(overshootMkv);
    expect(
      await buildZeroCopyHevcProfileFix(overshootMkv, overshootInsp!),
    ).toEqual({
      ok: false,
      reason: "mkv-probe-unreadable",
    });

    // R5-3c：大型 MKV 在首個 Cluster 前放 65 個 Void（firstClusterOffset === null），即使後段有乾淨 Cue 也須拒絕
    const voids65 = Array.from({ length: 65 }, () =>
      ebmlEl([0xec], new Uint8Array([0x00])),
    );
    const voidsBytes = concat(...voids65);
    const makeCleanCue = (pos: number) =>
      ebmlEl(
        [0x1c, 0x53, 0xbb, 0x6b],
        ebmlEl(
          [0xbb],
          ebmlEl(
            [0xb7],
            concat(
              ebmlEl([0xf7], new Uint8Array([1])),
              ebmlEl([0xf1], u32(pos)),
            ),
          ),
        ),
      );
    const cleanCueLen = makeCleanCue(0).length;
    const cleanClusterPos =
      tracks.length + cleanCueLen + voidsBytes.length + spsCluster.length;
    const largeVoidsMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        makeCleanCue(cleanClusterPos),
        voidsBytes,
        spsCluster,
        cleanCluster,
        pad45MB,
      ],
      { type: "video/x-matroska" },
    );
    const largeVoidsInsp = await inspectHevcProfile(largeVoidsMkv);
    expect(
      await buildZeroCopyHevcProfileFix(largeVoidsMkv, largeVoidsInsp!),
    ).toEqual({
      ok: false,
      reason: "mkv-probe-unreadable",
    });
  });
});
