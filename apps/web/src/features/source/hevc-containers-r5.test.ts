import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEVC_NAL_SPS,
  HEVC_PROFILE_MAIN_10,
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

function mp4Box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function makeSyntheticSps(bitDepthMinus8 = 0) {
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
  pushBits(0, 3);
  pushBits(1, 1);
  pushBits(0, 2);
  pushBits(0, 1);
  pushBits(HEVC_PROFILE_MAIN_10, 5);
  pushBits(0x20, 8);
  for (let i = 0; i < 9; i += 1) pushBits(0, 8);
  pushBits(93, 8);
  pushUE(0);
  pushUE(1);
  pushUE(160);
  pushUE(96);
  pushBits(0, 1);
  pushUE(bitDepthMinus8);
  pushUE(bitDepthMinus8);
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

function lenPrefix(nalu: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(u32(nalu.length), nalu);
}

describe("HEVC MKV probe regressions (R5 & R6 review fixes)", () => {
  it("handles mid-NAL cut on large MKV, 16 KiB SEI on small/large MKV, unreadable Cues, CueRelativePosition overshoot, >64 Voids, and BlockGroup bounds", async () => {
    const malformedMkv = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-malformed-aac.mkv"),
    );
    const origInsp = await inspectHevcProfile(
      new Blob([malformedMkv], { type: "video/x-matroska" }),
    );
    if (!origInsp || origInsp.container !== "mkv") {
      throw new Error("expected mkv");
    }

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
    const tcEl = ebmlEl([0xe7], new Uint8Array([0]));
    const segHdrUnknown = new Uint8Array([
      0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    const pad45MB = new Uint8Array(4_500_000);

    // R5-1：大型 MKV 的 16 KiB 探測視窗剛好切在第一個 SPS NAL 標頭第 1 byte（共 5 bytes）→ 不可放行修補
    const spsBlock = makeBlock(concat(lenPrefix(sps), lenPrefix(vcl)));
    const clusterHdrLen = 7;
    const blockHdrLen = 1 + 1 + 4;
    const voidHdrLen = 1 + 2;
    const voidPayloadLen =
      16_384 - clusterHdrLen - tcEl.length - voidHdrLen - blockHdrLen - 5;
    const midCutCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, ebmlEl([0xec], new Uint8Array(voidPayloadLen)), spsBlock),
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

    // R5-2：小型 MKV 的前置 SEI 超過 16 KiB（17,000 bytes），觸發完整重讀後方 SPS + VCL → 維持 mismatch=true 並修補成功
    const bigSei = new Uint8Array(17_000);
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
    expect(smallSeiInsp?.info.hasInBandParameterSets).toBe(true);
    expect(
      (await buildZeroCopyHevcProfileFix(smallSeiMkv, smallSeiInsp!)).ok,
    ).toBe(true);

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
    const makeRelCue = (cPos: number, relPos: number) =>
      ebmlEl(
        [0x1c, 0x53, 0xbb, 0x6b],
        ebmlEl(
          [0xbb],
          ebmlEl(
            [0xb7],
            concat(
              ebmlEl([0xf7], new Uint8Array([1])),
              ebmlEl([0xf1], u32(cPos)),
              ebmlEl([0xf0], u32(relPos)),
            ),
          ),
        ),
      );
    const cueLen = makeRelCue(0, 0).length;
    const c1Pos = tracks.length + cueLen + cleanCluster.length;
    const overshootRel = spsCluster.length + 5 + tcEl.length;
    const overshootMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        makeRelCue(c1Pos, overshootRel),
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

    // R5-3c：大型 MKV 首個 Cluster 前有 65 個 Void（firstClusterOffset === null），即使後段有乾淨 Cue 也須拒絕
    const voidsBytes = concat(
      ...Array.from({ length: 65 }, () => ebmlEl([0xec], new Uint8Array([0]))),
    );
    const makeClusterCue = (pos: number) =>
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
    const cleanClusterPos =
      tracks.length +
      makeClusterCue(0).length +
      voidsBytes.length +
      spsCluster.length;
    const largeVoidsMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        makeClusterCue(cleanClusterPos),
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

    // R6-1：大型 MKV 探測視窗切在 17 KiB SEI 中段 → 仍須保留 mismatch=true 診斷且拒改（mkv-probe-unreadable）
    const hugeSei = new Uint8Array(17_000);
    hugeSei[0] = (39 << 1) & 0x7e;
    hugeSei[1] = 0x01;
    const largeSeiCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(
        tcEl,
        makeBlock(concat(lenPrefix(hugeSei), lenPrefix(sps), lenPrefix(vcl))),
      ),
    );
    const largeSeiMkv = new Blob(
      [ebmlHeader, segHdrUnknown, tracks, largeSeiCluster, pad45MB],
      { type: "video/x-matroska" },
    );
    const largeSeiInsp = await inspectHevcProfile(largeSeiMkv);
    expect(largeSeiInsp?.info.mismatchMain10On8Bit).toBe(true);
    expect(
      await buildZeroCopyHevcProfileFix(largeSeiMkv, largeSeiInsp!),
    ).toEqual({
      ok: false,
      reason: "mkv-probe-unreadable",
    });

    // R6-2：損毀 BlockGroup（越界 Block、或有效 Block 後帶未知長度子元素）在首 Cluster、無相對位置 Cue、有相對位置 Cue 三條路徑皆須拒改
    const badBgBlock = concat(
      new Uint8Array([0xa1, 0x90, 0x81, 0x00, 0x00, 0x00]),
      lenPrefix(vcl),
    );
    const badBgCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, ebmlEl([0xa0], badBgBlock.subarray(0, 12))),
    );
    // 路徑 A：Cue 帶相對位置指向越界 BlockGroup
    const bgClusterPos = tracks.length + cueLen + cleanCluster.length;
    const badBgRelMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        makeRelCue(bgClusterPos, tcEl.length),
        cleanCluster,
        badBgCluster,
        pad45MB,
      ],
      { type: "video/x-matroska" },
    );
    expect(
      await buildZeroCopyHevcProfileFix(
        badBgRelMkv,
        (await inspectHevcProfile(badBgRelMkv))!,
      ),
    ).toEqual({ ok: false, reason: "mkv-probe-unreadable" });

    // 路徑 B：越界 BlockGroup 位於首 Cluster
    const badBgFirstMkv = new Blob(
      [ebmlHeader, segHdrUnknown, tracks, badBgCluster, pad45MB],
      { type: "video/x-matroska" },
    );
    expect(
      await buildZeroCopyHevcProfileFix(
        badBgFirstMkv,
        (await inspectHevcProfile(badBgFirstMkv))!,
      ),
    ).toEqual({ ok: false, reason: "mkv-probe-unreadable" });

    // 路徑 C：無相對位置 Cue 指向越界 BlockGroup
    const bgNoRelPos =
      tracks.length + makeClusterCue(0).length + cleanCluster.length;
    const badBgNoRelMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        makeClusterCue(bgNoRelPos),
        cleanCluster,
        badBgCluster,
        pad45MB,
      ],
      { type: "video/x-matroska" },
    );
    expect(
      await buildZeroCopyHevcProfileFix(
        badBgNoRelMkv,
        (await inspectHevcProfile(badBgNoRelMkv))!,
      ),
    ).toEqual({ ok: false, reason: "mkv-probe-unreadable" });

    // 路徑 D：BlockGroup 內有效 Block 後方緊接未知長度子元素（0xFB 0xFF）→ 不可提前返回放行
    const validBlockInBg = ebmlEl(
      [0xa1],
      concat(new Uint8Array([0x81, 0x00, 0x00, 0x00]), lenPrefix(vcl)),
    );
    const trailingUnknownBg = ebmlEl(
      [0xa0],
      concat(validBlockInBg, new Uint8Array([0xfb, 0xff, 0x01])),
    );
    const trailingUnknownCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, trailingUnknownBg),
    );
    const trailingMkv = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        makeRelCue(bgClusterPos, tcEl.length),
        cleanCluster,
        trailingUnknownCluster,
        pad45MB,
      ],
      { type: "video/x-matroska" },
    );
    expect(
      await buildZeroCopyHevcProfileFix(
        trailingMkv,
        (await inspectHevcProfile(trailingMkv))!,
      ),
    ).toEqual({ ok: false, reason: "mkv-probe-unreadable" });

    // 路徑 E：BlockGroup 超出 16 KiB 探測視窗，但在視窗內有效 Block 後含無效 VINT（0xFB 0x00）→ 三條路徑均須拒改
    const invalidVintBg = ebmlEl(
      [0xa0],
      concat(
        validBlockInBg,
        new Uint8Array([0xfb, 0x00]),
        new Uint8Array(18_000),
      ),
    );
    const invalidVintCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, invalidVintBg),
    );
    for (const badBlob of [
      // 首 Cluster
      new Blob(
        [ebmlHeader, segHdrUnknown, tracks, invalidVintCluster, pad45MB],
        {
          type: "video/x-matroska",
        },
      ),
      // 有相對位置 Cue
      new Blob(
        [
          ebmlHeader,
          segHdrUnknown,
          tracks,
          makeRelCue(bgClusterPos, tcEl.length),
          cleanCluster,
          invalidVintCluster,
          pad45MB,
        ],
        { type: "video/x-matroska" },
      ),
      // 無相對位置 Cue
      new Blob(
        [
          ebmlHeader,
          segHdrUnknown,
          tracks,
          makeClusterCue(bgNoRelPos),
          cleanCluster,
          invalidVintCluster,
          pad45MB,
        ],
        { type: "video/x-matroska" },
      ),
    ]) {
      expect(
        await buildZeroCopyHevcProfileFix(
          badBlob,
          (await inspectHevcProfile(badBlob))!,
        ),
      ).toEqual({ ok: false, reason: "mkv-probe-unreadable" });
    }

    // 路徑 F：探測視窗最後 1 byte 為部分 VINT（0x01 需 8 bytes 或 0x41 最小 payload 256 bytes），但父 BlockGroup 空間不足 → 拒改
    const buildCutVintBgCluster = (
      windowBytes: number,
      prefixBytes: number,
      tail: number[],
    ) => {
      const padPayloadLen =
        windowBytes - prefixBytes - 4 - validBlockInBg.length - 3 - 2;
      const bg = ebmlEl(
        [0xa0],
        concat(
          validBlockInBg,
          ebmlEl([0xec], new Uint8Array(padPayloadLen)),
          new Uint8Array(tail),
        ),
      );
      return ebmlEl([0x1f, 0x43, 0xb6, 0x75], concat(tcEl, bg));
    };
    const cut16kCluster = buildCutVintBgCluster(
      16_384,
      7 + tcEl.length,
      [0xfb, 0x01, 0x00],
    );
    const cut8kCluster = buildCutVintBgCluster(8_192, 0, [0xfb, 0x01, 0x00]);
    const cutMinValCluster = buildCutVintBgCluster(
      16_384,
      7 + tcEl.length,
      [0xfb, 0x41, 0x00, 0x00, 0x00],
    );
    for (const badCutBlob of [
      // 首 Cluster（16 KiB 視窗，8-byte VINT 超出剩餘 2 bytes）
      new Blob([ebmlHeader, segHdrUnknown, tracks, cut16kCluster, pad45MB], {
        type: "video/x-matroska",
      }),
      // 首 Cluster（16 KiB 視窗，2-byte VINT 0x41 最小 payload 256 > 剩餘 2 bytes）
      new Blob([ebmlHeader, segHdrUnknown, tracks, cutMinValCluster, pad45MB], {
        type: "video/x-matroska",
      }),
      // 無相對位置 Cue（16 KiB 視窗）
      new Blob(
        [
          ebmlHeader,
          segHdrUnknown,
          tracks,
          makeClusterCue(bgNoRelPos),
          cleanCluster,
          cut16kCluster,
          pad45MB,
        ],
        { type: "video/x-matroska" },
      ),
      // 有相對位置 Cue（8 KiB 視窗）
      new Blob(
        [
          ebmlHeader,
          segHdrUnknown,
          tracks,
          makeRelCue(bgClusterPos, tcEl.length),
          cleanCluster,
          cut8kCluster,
          pad45MB,
        ],
        { type: "video/x-matroska" },
      ),
    ]) {
      expect(
        await buildZeroCopyHevcProfileFix(
          badCutBlob,
          (await inspectHevcProfile(badCutBlob))!,
        ),
      ).toEqual({ ok: false, reason: "mkv-probe-unreadable" });
    }
  });

  it("refuses hvc1 MP4 when a 66 KiB SEI in a probed keyframe hides a true 10-bit SPS", async () => {
    const sps8 = makeSyntheticSps(0);
    const sps10 = makeSyntheticSps(2);
    const hvcc = new Uint8Array(23 + 5 + sps8.length);
    hvcc[0] = 1;
    hvcc[1] = HEVC_PROFILE_MAIN_10;
    hvcc[2] = 0x20;
    hvcc[12] = 93;
    hvcc[16] = 0xfd;
    hvcc[17] = 0xf8;
    hvcc[18] = 0xf8;
    hvcc[21] = 0x03;
    hvcc[22] = 1;
    hvcc[23] = 0x80 | HEVC_NAL_SPS;
    hvcc[24] = 0;
    hvcc[25] = 1;
    hvcc[26] = (sps8.length >> 8) & 0xff;
    hvcc[27] = sps8.length & 0xff;
    hvcc.set(sps8, 28);

    const vcl = new Uint8Array([0x26, 0x01, 0xde, 0xad]);
    const sei66k = new Uint8Array(66_000);
    sei66k[0] = (39 << 1) & 0x7e;
    sei66k[1] = 0x01;
    const s1 = lenPrefix(vcl);
    const s2 = concat(lenPrefix(sei66k), lenPrefix(sps10), lenPrefix(vcl));

    const hvc1 = mp4Box(
      "hvc1",
      concat(new Uint8Array(78), mp4Box("hvcC", hvcc)),
    );
    const stsd = mp4Box("stsd", concat(u32(0), u32(1), hvc1));
    const stsc = mp4Box("stsc", concat(u32(0), u32(1), u32(1), u32(2), u32(1)));
    const stsz = mp4Box(
      "stsz",
      concat(u32(0), u32(0), u32(2), u32(s1.length), u32(s2.length)),
    );
    const stss = mp4Box("stss", concat(u32(0), u32(2), u32(1), u32(2)));
    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isom"));
    const mdat = mp4Box("mdat", concat(s1, s2));
    const build = (off: number) => {
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
    const mdatStart = ftyp.length + build(0).moov.length + 8;
    const blob = new Blob([build(mdatStart).bytes], { type: "video/mp4" });

    const insp = await inspectHevcProfile(blob);
    expect(insp?.container).toBe("mp4");
    expect(insp?.info.mismatchMain10On8Bit).toBe(false);
    expect(insp?.info.unsafeReason).toBe("unparsed-sps");
    expect(await buildZeroCopyHevcProfileFix(blob, insp!)).toEqual({
      ok: false,
      reason: "unparsed-sps",
    });
  });
});
