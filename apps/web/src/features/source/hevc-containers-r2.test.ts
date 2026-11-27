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
import {
  EBML_ID_BLOCK_GROUP,
  EBML_ID_CLUSTER,
  EBML_ID_CRC32,
  EBML_ID_TRACK_ENTRY,
  EBML_ID_TRACKS,
  computeEbmlCrc32,
  iterateEbmlChildren,
} from "./hevc-ebml";
import { buildZeroCopyHevcProfileFix, inspectHevcProfile } from "./hevc-header";

const FIXTURES_DIR = resolve(process.cwd(), "e2e/fixtures");

function u32(val: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, val, false);
  return out;
}

function u64(val: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, val, false);
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

function mp4Box64(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(16 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  view.setBigUint64(8, BigInt(out.length), false);
  out.set(payload, 16);
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

/** 加上 RFC 8794 §14.2 合法 EBML CRC-32（0xBF）於 Master Element 開頭。 */
function ebmlMasterWithCrc(
  idBytes: number[],
  bodyPayload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const crc = computeEbmlCrc32([bodyPayload]);
  const crcBytes = new Uint8Array(4);
  new DataView(crcBytes.buffer).setUint32(0, crc, true);
  const crcEl = ebmlEl([EBML_ID_CRC32], crcBytes);
  return ebmlEl(idBytes, concat(crcEl, bodyPayload));
}

function makeSyntheticSps(compatBytes: [number, number, number, number]) {
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
  for (const b of compatBytes) pushBits(b, 8);
  for (let i = 0; i < 6; i += 1) pushBits(0, 8);
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

function makeHvccWithSps(sps: Uint8Array, compatB1: number) {
  const out = new Uint8Array(23 + 5 + sps.length);
  out[0] = 1;
  out[1] = HEVC_PROFILE_MAIN_10;
  out[2] = compatB1;
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

describe("HEVC container regressions (R2 review fixes)", () => {
  it("preserves 64-bit container box headers (dinf/moov) during variable-length MP4 moov rebuild and handles co64", async () => {
    const shrinkingSps = makeSyntheticSps([0x00, 0x00, 0x01, 0x80]);
    const hvcc = makeHvccWithSps(shrinkingSps, 0x00);
    const hvc1 = mp4Box(
      "hvc1",
      concat(new Uint8Array(78), mp4Box("hvcC", hvcc)),
    );
    const stsd = mp4Box("stsd", concat(u32(0), u32(1), hvc1));
    const stsc = mp4Box("stsc", concat(u32(0), u32(1), u32(1), u32(1), u32(1)));
    const stsz = mp4Box("stsz", concat(u32(0), u32(4), u32(1)));
    // 在 minf 內放入 64-bit header（16 bytes）的 dinf，模擬 GPT 第二輪審查重現
    const dinf64 = mp4Box64("dinf", mp4Box("dref", concat(u32(0), u32(0))));
    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isom"));
    const mdat = mp4Box("mdat", new Uint8Array([0xab, 0xcd, 0xef, 0x01]));

    const buildWithOffsetBox = (offsetBox: Uint8Array) => {
      const moov = mp4Box64(
        "moov",
        mp4Box(
          "trak",
          mp4Box(
            "mdia",
            mp4Box(
              "minf",
              concat(
                dinf64,
                mp4Box("stbl", concat(stsd, stsc, stsz, offsetBox)),
              ),
            ),
          ),
        ),
      );
      return { moov, bytes: concat(ftyp, moov, mdat) };
    };

    // 1. stco 案例：驗證 64-bit dinf 與 64-bit moov 標頭長度不被縮成 8 bytes，stco 指回精確 0xab
    const probeStco = buildWithOffsetBox(
      mp4Box("stco", concat(u32(0), u32(1), u32(0))),
    );
    const mdatStart = ftyp.length + probeStco.moov.length + 8;
    const { bytes } = buildWithOffsetBox(
      mp4Box("stco", concat(u32(0), u32(1), u32(mdatStart))),
    );
    const blob = new Blob([bytes], { type: "video/mp4" });
    const inspected = await inspectHevcProfile(blob);
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    const fix = await buildZeroCopyHevcProfileFix(blob, inspected!);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;

    const patched = new Uint8Array(await fix.blob.arrayBuffer());
    expect(patched.length).toBe(bytes.length - 1);
    const view = new DataView(patched.buffer);
    let stcoOffsetVal = -1;
    let dinfHeaderIs64 = false;
    for (let i = 0; i + 16 <= patched.length; i += 1) {
      if (
        patched[i + 4] === 0x73 &&
        patched[i + 5] === 0x74 &&
        patched[i + 6] === 0x63 &&
        patched[i + 7] === 0x6f
      ) {
        stcoOffsetVal = view.getUint32(i + 16, false);
      }
      if (
        patched[i + 4] === 0x64 &&
        patched[i + 5] === 0x69 &&
        patched[i + 6] === 0x6e &&
        patched[i + 7] === 0x66
      ) {
        dinfHeaderIs64 = view.getUint32(i, false) === 1;
      }
    }
    expect(dinfHeaderIs64).toBe(true);
    expect(stcoOffsetVal).toBe(mdatStart - 1);
    expect(patched[stcoOffsetVal]).toBe(0xab);

    // 2. co64 案例：合法位移與落在 moov 範圍內的異常偏移拒絕
    const probeCo64 = buildWithOffsetBox(
      mp4Box("co64", concat(u32(0), u32(1), u64(0n))),
    );
    const co64MdatStart = BigInt(ftyp.length + probeCo64.moov.length + 8);
    const validCo64Bytes = buildWithOffsetBox(
      mp4Box("co64", concat(u32(0), u32(1), u64(co64MdatStart))),
    ).bytes;
    const co64Insp = await inspectHevcProfile(
      new Blob([validCo64Bytes], { type: "video/mp4" }),
    );
    const co64Fix = await buildZeroCopyHevcProfileFix(
      new Blob([validCo64Bytes], { type: "video/mp4" }),
      co64Insp!,
    );
    expect(co64Fix.ok).toBe(true);

    // 指向 moov 內部區段的無效 co64 必須拒絕
    const badCo64Bytes = buildWithOffsetBox(
      mp4Box("co64", concat(u32(0), u32(1), u64(BigInt(ftyp.length + 16)))),
    ).bytes;
    const badCo64Blob = new Blob([badCo64Bytes], { type: "video/mp4" });
    const badCo64Insp = await inspectHevcProfile(badCo64Blob);
    const badCo64Fix = await buildZeroCopyHevcProfileFix(
      badCo64Blob,
      badCo64Insp!,
    );
    expect(badCo64Fix).toEqual({
      ok: false,
      reason: "mp4-moov-offset-overflow",
    });
  });

  it("patches unindexed second keyframe in same Cluster, unknown-size Cluster chains, and updates all MKV CRC-32 elements", async () => {
    const malformedMkv = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-malformed-aac.mkv"),
    );
    const origInsp = await inspectHevcProfile(
      new Blob([malformedMkv], { type: "video/x-matroska" }),
    );
    expect(origInsp?.container).toBe("mkv");
    if (!origInsp || origInsp.container !== "mkv") return;

    const sps = makeSyntheticSps([0x20, 0x00, 0x00, 0x00]);
    const vcl = new Uint8Array([0x26, 0x01, 0x12, 0x34]);
    const kfPayload = concat(lenPrefix(sps), lenPrefix(vcl));
    const ebmlHeader = ebmlEl(
      [0x1a, 0x45, 0xdf, 0xa3],
      new Uint8Array([0x42, 0x86, 0x81, 0x01]),
    );
    const makeSimpleBlock = (flags: number, body: Uint8Array) =>
      ebmlEl([0xa3], concat(new Uint8Array([0x81, 0x00, 0x00, flags]), body));
    const makeBlockGroupWithCrc = (body: Uint8Array) =>
      ebmlMasterWithCrc(
        [0xa0],
        ebmlEl([0xa1], concat(new Uint8Array([0x81, 0x00, 0x00, 0x00]), body)),
      );

    // TrackEntry 與 Tracks 都帶合法 CRC-32
    const trackEntry = ebmlMasterWithCrc(
      [EBML_ID_TRACK_ENTRY],
      concat(
        ebmlEl([0xd7], new Uint8Array([1])),
        ebmlEl([0x83], new Uint8Array([1])),
        ebmlEl([0x86], new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
        ebmlEl([0x63, 0xa2], origInsp.codecPrivateBytes),
      ),
    );
    const tracksWithCrc = ebmlMasterWithCrc(
      [0x16, 0x54, 0xae, 0x6b],
      trackEntry,
    );
    const clusterTimecode = ebmlEl([0xe7], new Uint8Array([0x00]));
    const kf1 = makeSimpleBlock(0x80, kfPayload);
    const kf2Group = makeBlockGroupWithCrc(kfPayload);

    // 情境 1：同一個帶 CRC-32 的 Cluster 有兩個關鍵幀（第二個用帶 CRC-32 的 BlockGroup），
    // 且透過 SeekHead 指向的 Cues 只索引第一個關鍵幀 → 兩者都要修補，且 4 處 CRC-32 全部重算有效！
    const clusterWithCrc = ebmlMasterWithCrc(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(clusterTimecode, kf1, kf2Group),
    );
    const u16be = (v: number) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
    const makeSeekHead = (cuesPos: number) =>
      ebmlEl(
        [0x11, 0x4d, 0x9b, 0x74],
        ebmlEl(
          [0x4d, 0xbb],
          concat(
            ebmlEl([0x53, 0xab], new Uint8Array([0x1c, 0x53, 0xbb, 0x6b])),
            ebmlEl([0x53, 0xac], u16be(cuesPos)),
          ),
        ),
      );
    const shSize = makeSeekHead(0).length;
    const clusterPos = shSize + tracksWithCrc.length;
    const cuesOnlyFirst = ebmlEl(
      [0x1c, 0x53, 0xbb, 0x6b],
      ebmlEl(
        [0xbb],
        ebmlEl(
          [0xb7],
          concat(
            ebmlEl([0xf7], new Uint8Array([1])),
            ebmlEl([0xf1], u16be(clusterPos)),
            ebmlEl([0xf0], u16be(6 + clusterTimecode.length)),
          ),
        ),
      ),
    );
    const seekHead = makeSeekHead(clusterPos + clusterWithCrc.length);
    const mkv1 = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl(
            [0x18, 0x53, 0x80, 0x67],
            concat(seekHead, tracksWithCrc, clusterWithCrc, cuesOnlyFirst),
          ),
        ),
      ],
      { type: "video/x-matroska" },
    );

    const ins1 = await inspectHevcProfile(mkv1);
    expect(ins1?.container).toBe("mkv");
    if (ins1?.container === "mkv") {
      expect(ins1.cueTargets).toHaveLength(1);
      expect(ins1.cueTargets[0]?.relativePosition).not.toBeNull();
    }
    const fix1 = await buildZeroCopyHevcProfileFix(mkv1, ins1!);
    expect(fix1.ok).toBe(true);
    if (!fix1.ok) return;

    const out1 = new Uint8Array(await fix1.blob.arrayBuffer());
    expect(out1.length).toBe(mkv1.size);
    // 驗證兩個關鍵幀的 in-band SPS 全部改成 Main
    const spsProfiles: number[] = [];
    for (let i = 0; i + 4 + sps.length <= out1.length; i += 1) {
      if (
        out1[i] === 0 &&
        out1[i + 1] === 0 &&
        out1[i + 2] === 0 &&
        out1[i + 3] === sps.length &&
        ((out1[i + 4]! >> 1) & 0x3f) === HEVC_NAL_SPS
      ) {
        const res = inspectSampleParameterSets(
          out1.subarray(i, i + 4 + sps.length),
          4,
        );
        if (res.spsList[0]) spsProfiles.push(res.spsList[0].generalProfileIdc);
      }
    }
    expect(spsProfiles).toEqual([HEVC_PROFILE_MAIN, HEVC_PROFILE_MAIN]);

    // 驗證 Tracks、TrackEntry、Cluster、BlockGroup 共 4 個 CRC-32 全數有效
    const checkedIds = new Set([
      0x18538067,
      EBML_ID_TRACKS,
      EBML_ID_TRACK_ENTRY,
      EBML_ID_CLUSTER,
      EBML_ID_BLOCK_GROUP,
    ]);
    let validCrcs = 0;
    const checkCrc = (start: number, end: number) => {
      for (const el of iterateEbmlChildren(out1, start, end)) {
        if (!checkedIds.has(el.id)) continue;
        for (const ch of iterateEbmlChildren(out1, el.dataStart, el.dataEnd)) {
          if (ch.id === EBML_ID_CRC32) {
            const stored = new DataView(
              out1.buffer,
              out1.byteOffset + ch.dataStart,
              4,
            ).getUint32(0, true);
            const expected = computeEbmlCrc32([
              out1.subarray(el.dataStart, ch.elementStart),
              out1.subarray(ch.dataEnd, el.dataEnd),
            ]);
            expect(stored).toBe(expected);
            validCrcs += 1;
          }
        }
        checkCrc(el.dataStart, el.dataEnd);
      }
    };
    checkCrc(0, out1.length);
    expect(validCrcs).toBe(4);

    // 情境 2：未知長度 Cluster（0xFF）後接第二個 Cluster → 兩個 Cluster 的關鍵幀都必須修補
    const unknownCluster1 = concat(
      new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0xff]),
      clusterTimecode,
      kf1,
    );
    const cluster2 = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(ebmlEl([0xe7], new Uint8Array([0x01])), kf1),
    );
    const mkvUnknown = new Blob(
      [
        concat(
          ebmlHeader,
          new Uint8Array([
            0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff,
          ]),
          tracksWithCrc,
          unknownCluster1,
          cluster2,
        ),
      ],
      { type: "video/x-matroska" },
    );
    const insUnknown = await inspectHevcProfile(mkvUnknown);
    expect(insUnknown?.info.mismatchMain10On8Bit).toBe(true);
    const fixUnknown = await buildZeroCopyHevcProfileFix(
      mkvUnknown,
      insUnknown!,
    );
    expect(fixUnknown.ok).toBe(true);
    if (!fixUnknown.ok) return;
    const outUnknown = new Uint8Array(await fixUnknown.blob.arrayBuffer());
    const unknownProfiles: number[] = [];
    for (let i = 0; i + 4 + sps.length <= outUnknown.length; i += 1) {
      if (
        outUnknown[i] === 0 &&
        outUnknown[i + 1] === 0 &&
        outUnknown[i + 2] === 0 &&
        outUnknown[i + 3] === sps.length &&
        ((outUnknown[i + 4]! >> 1) & 0x3f) === HEVC_NAL_SPS
      ) {
        const res = inspectSampleParameterSets(
          outUnknown.subarray(i, i + 4 + sps.length),
          4,
        );
        if (res.spsList[0]) {
          unknownProfiles.push(res.spsList[0].generalProfileIdc);
        }
      }
    }
    expect(unknownProfiles).toEqual([HEVC_PROFILE_MAIN, HEVC_PROFILE_MAIN]);

    // 情境 3：Segment 本身帶有 CRC-32 → 明確降級拒改
    const segWithCrc = ebmlMasterWithCrc(
      [0x18, 0x53, 0x80, 0x67],
      concat(tracksWithCrc, cluster2),
    );
    const mkvSegCrc = new Blob([concat(ebmlHeader, segWithCrc)], {
      type: "video/x-matroska",
    });
    const insSegCrc = await inspectHevcProfile(mkvSegCrc);
    const fixSegCrc = await buildZeroCopyHevcProfileFix(mkvSegCrc, insSegCrc!);
    expect(fixSegCrc).toEqual({
      ok: false,
      reason: "mkv-segment-crc32-unsupported",
    });
  });
});
