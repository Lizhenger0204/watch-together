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

function makeSyntheticSps() {
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

    // R5-2：小型 MKV 的前置 SEI 佔滿 16 KiB，後方完整接 SPS + VCL → 維持 mismatch=true 並修補成功
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

    // R6-2：Cue 指向的 BlockGroup 內含宣告越出 BlockGroup 邊界的 Block → 不可當成乾淨，須回傳 mkv-probe-unreadable
    const badBgBlock = concat(
      new Uint8Array([0xa1, 0x90, 0x81, 0x00, 0x00, 0x00]),
      lenPrefix(vcl),
    );
    const badBgCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, ebmlEl([0xa0], badBgBlock.subarray(0, 12))),
    );
    const bgClusterPos = tracks.length + cueLen + cleanCluster.length;
    const badBgLargeMkv = new Blob(
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
    const badBgLargeInsp = await inspectHevcProfile(badBgLargeMkv);
    expect(
      await buildZeroCopyHevcProfileFix(badBgLargeMkv, badBgLargeInsp!),
    ).toEqual({
      ok: false,
      reason: "mkv-probe-unreadable",
    });
  });
});
