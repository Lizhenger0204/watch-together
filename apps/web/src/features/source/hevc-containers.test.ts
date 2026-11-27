import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEVC_PROFILE_MAIN,
  HEVC_PROFILE_MAIN_10,
  inspectSampleParameterSets,
  rbspToEbsp,
  HEVC_NAL_SPS,
} from "./hevc-bitstream";
import {
  EBML_ID_BLOCK_GROUP,
  EBML_ID_CLUSTER,
  EBML_ID_CRC32,
  EBML_ID_CUES,
  EBML_ID_INFO,
  EBML_ID_SEEK_HEAD,
  EBML_ID_SEGMENT,
  EBML_ID_TAGS,
  EBML_ID_TRACK_ENTRY,
  EBML_ID_TRACKS,
  computeEbmlCrc32,
  iterateEbmlChildren,
} from "./hevc-ebml";
import { buildZeroCopyHevcProfileFix, inspectHevcProfile } from "./hevc-header";

const FIXTURES_DIR = resolve(process.cwd(), "e2e/fixtures");

function readFixtureBlob(name: string, type: string) {
  const buf = readFileSync(resolve(FIXTURES_DIR, name));
  return new Blob([buf], { type });
}

function u32(val: number) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, val, false);
  return out;
}

function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function mp4Box64(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  view.setBigUint64(8, BigInt(out.length), false);
  out.set(payload, 16);
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

function ebmlVint(value: number): Uint8Array {
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

function ebmlEl(idBytes: number[], payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array(idBytes), ebmlVint(payload.length), payload);
}

/** 製造 EPB 會在改寫後少 1 位元組的 SPS（compatB1 === 0x00 且後續全為 0x00）。 */
function makeShrinkingEpbSps(): Uint8Array {
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
  // compat = 0x00 0x00 0x01 0x80 -> 原 EBSP 為 00 00 [03] 01 80，改成 0x40 後縮短 1 byte
  pushBits(0x00, 8);
  pushBits(0x00, 8);
  pushBits(0x01, 8);
  pushBits(0x80, 8);
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

describe("HEVC container inspection and zero-copy patching", () => {
  it("distinguishes all 8 real MP4 and MKV fixtures accurately", async () => {
    const cases: [string, string, number, number, boolean][] = [
      ["hevc-aac.mp4", "video/mp4", HEVC_PROFILE_MAIN, 8, false],
      ["hevc-main10-aac.mp4", "video/mp4", HEVC_PROFILE_MAIN_10, 10, false],
      [
        "hevc-main10-8bit-malformed-aac.mp4",
        "video/mp4",
        HEVC_PROFILE_MAIN_10,
        8,
        true,
      ],
      [
        "hevc-main10-8bit-fixed-aac.mp4",
        "video/mp4",
        HEVC_PROFILE_MAIN,
        8,
        false,
      ],
      ["hevc-aac.mkv", "video/x-matroska", HEVC_PROFILE_MAIN, 8, false],
      [
        "hevc-main10-aac.mkv",
        "video/x-matroska",
        HEVC_PROFILE_MAIN_10,
        10,
        false,
      ],
      [
        "hevc-main10-8bit-malformed-aac.mkv",
        "video/x-matroska",
        HEVC_PROFILE_MAIN_10,
        8,
        true,
      ],
      [
        "hevc-main10-8bit-fixed-aac.mkv",
        "video/x-matroska",
        HEVC_PROFILE_MAIN,
        8,
        false,
      ],
    ];

    for (const [name, mime, profileIdc, bitDepth, mismatch] of cases) {
      const inspected = await inspectHevcProfile(readFixtureBlob(name, mime));
      expect(inspected, name).not.toBeNull();
      expect(inspected!.info.declaredProfileIdc, name).toBe(profileIdc);
      expect(inspected!.info.bitDepthLuma, name).toBe(bitDepth);
      expect(inspected!.info.bitDepthChroma, name).toBe(bitDepth);
      expect(inspected!.info.mismatchMain10On8Bit, name).toBe(mismatch);
      expect(inspected!.info.unsafeReason, name).toBeNull();
    }

    // 確認非 HEVC（H.264）不會誤報
    const h264 = await inspectHevcProfile(
      readFixtureBlob("h264-aac.mp4", "video/mp4"),
    );
    expect(h264).toBeNull();
  });

  it("zero-copy patches real malformed MP4 to match fixed fixture", async () => {
    const malformed = readFixtureBlob(
      "hevc-main10-8bit-malformed-aac.mp4",
      "video/mp4",
    );
    const expectedFixed = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-fixed-aac.mp4"),
    );

    const inspected = await inspectHevcProfile(malformed);
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    expect(inspected?.info.hasInBandParameterSets).toBe(false);

    const fix = await buildZeroCopyHevcProfileFix(malformed, inspected!);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    expect(fix.patchedRanges).toBe(1);

    const patchedBytes = new Uint8Array(await fix.blob.arrayBuffer());
    expect(Buffer.from(patchedBytes).equals(expectedFixed)).toBe(true);

    const reinspected = await inspectHevcProfile(fix.blob);
    expect(reinspected?.info).toMatchObject({
      declaredProfileIdc: HEVC_PROFILE_MAIN,
      bitDepthLuma: 8,
      mismatchMain10On8Bit: false,
    });
  });

  it("zero-copy patches real malformed MKV including repeated in-band VPS/SPS across keyframes", async () => {
    const malformed = readFixtureBlob(
      "hevc-main10-8bit-malformed-aac.mkv",
      "video/x-matroska",
    );
    const inspected = await inspectHevcProfile(malformed);
    expect(inspected?.container).toBe("mkv");
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    expect(inspected?.info.hasInBandParameterSets).toBe(true);

    const fix = await buildZeroCopyHevcProfileFix(malformed, inspected!);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    // CodecPrivate + 2 個關鍵幀 in-band VPS/SPS + Tracks／2 個 Cluster 的 CRC-32 更新共 6 處
    expect(fix.patchedRanges).toBe(6);

    const reinspected = await inspectHevcProfile(fix.blob);
    expect(reinspected?.info).toMatchObject({
      declaredProfileIdc: HEVC_PROFILE_MAIN,
      bitDepthLuma: 8,
      mismatchMain10On8Bit: false,
      hasInBandParameterSets: true,
    });

    // 驗證修補後的 MKV 內全部 EBML CRC-32（SeekHead、Info、Tracks、Tags、2 個 Cluster、Cues）皆有效
    const patchedBuf = new Uint8Array(await fix.blob.arrayBuffer());
    const masterIds = new Set([
      EBML_ID_SEGMENT,
      EBML_ID_SEEK_HEAD,
      EBML_ID_INFO,
      EBML_ID_TRACKS,
      EBML_ID_TRACK_ENTRY,
      EBML_ID_TAGS,
      EBML_ID_CLUSTER,
      EBML_ID_BLOCK_GROUP,
      EBML_ID_CUES,
    ]);
    let verifiedCrcCount = 0;
    const verifyCrcTree = (start: number, end: number) => {
      for (const el of iterateEbmlChildren(patchedBuf, start, end)) {
        if (!masterIds.has(el.id)) continue;
        const children = iterateEbmlChildren(
          patchedBuf,
          el.dataStart,
          el.dataEnd,
        );
        for (const child of children) {
          if (child.id === EBML_ID_CRC32) {
            const stored = new DataView(
              patchedBuf.buffer,
              patchedBuf.byteOffset + child.dataStart,
              4,
            ).getUint32(0, true);
            const computed = computeEbmlCrc32([
              patchedBuf.subarray(el.dataStart, child.elementStart),
              patchedBuf.subarray(child.dataEnd, el.dataEnd),
            ]);
            expect(stored).toBe(computed);
            verifiedCrcCount += 1;
          }
        }
        verifyCrcTree(el.dataStart, el.dataEnd);
      }
    };
    verifyCrcTree(0, patchedBuf.length);
    expect(verifiedCrcCount).toBe(7);

    // 抽查兩個關鍵幀的 in-band SPS 確認均已改為 Main（1）
    let mainSpsCount = 0;
    let main10SpsCount = 0;
    for (let i = 0; i + 8 < patchedBuf.length; i += 1) {
      if (
        patchedBuf[i] === 0 &&
        patchedBuf[i + 1] === 0 &&
        patchedBuf[i + 2] === 0 &&
        patchedBuf[i + 3]! >= 20 &&
        patchedBuf[i + 3]! <= 80 &&
        ((patchedBuf[i + 4]! >> 1) & 0x3f) === HEVC_NAL_SPS
      ) {
        const res = inspectSampleParameterSets(
          patchedBuf.subarray(i, Math.min(patchedBuf.length, i + 128)),
          4,
        );
        for (const sps of res.spsList) {
          if (sps.generalProfileIdc === HEVC_PROFILE_MAIN) mainSpsCount += 1;
          if (sps.generalProfileIdc === HEVC_PROFILE_MAIN_10)
            main10SpsCount += 1;
        }
      }
    }
    expect(mainSpsCount).toBeGreaterThanOrEqual(2);
    expect(main10SpsCount).toBe(0);
  });

  it("handles MP4 with 64-bit mdat and moov at EOF", async () => {
    const malformedBytes = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-malformed-aac.mp4"),
    );
    const inspectedOrig = await inspectHevcProfile(
      new Blob([malformedBytes], { type: "video/mp4" }),
    );
    expect(inspectedOrig?.container).toBe("mp4");
    if (!inspectedOrig || inspectedOrig.container !== "mp4") return;

    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isom"));
    const mdat64 = mp4Box64("mdat", new Uint8Array(64));
    const endMoovFile = new Blob(
      [concat(ftyp, mdat64, inspectedOrig.moovBytes)],
      {
        type: "video/mp4",
      },
    );

    const inspected = await inspectHevcProfile(endMoovFile);
    expect(inspected?.container).toBe("mp4");
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    const fix = await buildZeroCopyHevcProfileFix(endMoovFile, inspected!);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    const reinspected = await inspectHevcProfile(fix.blob);
    expect(reinspected?.info.declaredProfileIdc).toBe(HEVC_PROFILE_MAIN);
  });

  it("rebuilds MP4 moov and shifts both video and audio stco when EPB changes hvcC length", async () => {
    const sps = makeShrinkingEpbSps();
    const hvccPayload = new Uint8Array(23 + 5 + sps.length);
    hvccPayload[0] = 1;
    hvccPayload[1] = HEVC_PROFILE_MAIN_10;
    hvccPayload[2] = 0x00;
    hvccPayload[12] = 93;
    hvccPayload[16] = 0xfd; // 4:2:0
    hvccPayload[17] = 0xf8; // 8-bit luma
    hvccPayload[18] = 0xf8; // 8-bit chroma
    hvccPayload[21] = 0x03;
    hvccPayload[22] = 1;
    hvccPayload[23] = 0x80 | HEVC_NAL_SPS;
    hvccPayload[24] = 0;
    hvccPayload[25] = 1;
    hvccPayload[26] = (sps.length >> 8) & 0xff;
    hvccPayload[27] = sps.length & 0xff;
    hvccPayload.set(sps, 28);

    const hvc1 = mp4Box(
      "hvc1",
      concat(new Uint8Array(78), mp4Box("hvcC", hvccPayload)),
    );
    const stsd = mp4Box("stsd", concat(u32(0), u32(1), hvc1));
    const stsc = mp4Box("stsc", concat(u32(0), u32(1), u32(1), u32(1), u32(1)));
    const stsz = mp4Box("stsz", concat(u32(0), u32(4), u32(1)));
    const makeStco = (offsetVal: number) =>
      mp4Box("stco", concat(u32(0), u32(1), u32(offsetVal)));

    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isom"));
    const buildFile = (vOffset: number, aOffset: number) => {
      const videoTrak = mp4Box(
        "trak",
        mp4Box(
          "mdia",
          mp4Box(
            "minf",
            mp4Box("stbl", concat(stsd, stsc, stsz, makeStco(vOffset))),
          ),
        ),
      );
      const audioTrak = mp4Box(
        "trak",
        mp4Box("mdia", mp4Box("minf", mp4Box("stbl", makeStco(aOffset)))),
      );
      const moov = mp4Box("moov", concat(videoTrak, audioTrak));
      const mdat = mp4Box(
        "mdat",
        new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x26, 0x01, 0x99, 0x88]),
      );
      return { moov, fileBytes: concat(ftyp, moov, mdat) };
    };

    const probe = buildFile(0, 0);
    const mdatPayloadStart = ftyp.length + probe.moov.length + 8;
    const { fileBytes } = buildFile(mdatPayloadStart, mdatPayloadStart + 4);
    const blob = new Blob([fileBytes], { type: "video/mp4" });

    const inspected = await inspectHevcProfile(blob);
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    const fix = await buildZeroCopyHevcProfileFix(blob, inspected!);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;

    const patched = new Uint8Array(await fix.blob.arrayBuffer());
    // EPB 移除使整個檔案縮短 1 byte
    expect(patched.length).toBe(fileBytes.length - 1);

    // 驗證 video 與 audio 兩條軌道的 stco 都正確平移 -1，仍指回 mdat 內的原資料位元組
    const view = new DataView(patched.buffer);
    const stcoValues: number[] = [];
    for (let i = 0; i + 16 <= patched.length; i += 1) {
      if (
        patched[i + 4] === 0x73 &&
        patched[i + 5] === 0x74 &&
        patched[i + 6] === 0x63 &&
        patched[i + 7] === 0x6f
      ) {
        stcoValues.push(view.getUint32(i + 16, false));
      }
    }
    expect(stcoValues).toEqual([mdatPayloadStart - 1, mdatPayloadStart + 3]);
    expect(patched[stcoValues[1]!]).toBe(0x26);
  });

  it("follows MKV SeekHead to Tracks at EOF and blocks tracks with ContentEncodings", async () => {
    const malformedMkv = readFixtureBlob(
      "hevc-main10-8bit-malformed-aac.mkv",
      "video/x-matroska",
    );
    const inspectedOrig = await inspectHevcProfile(malformedMkv);
    expect(inspectedOrig?.container).toBe("mkv");
    if (!inspectedOrig || inspectedOrig.container !== "mkv") return;

    const buildMkv = (withEncoding: boolean) => {
      const ebmlHeader = ebmlEl(
        [0x1a, 0x45, 0xdf, 0xa3],
        new Uint8Array([0x42, 0x86, 0x81, 0x01]),
      );
      const trackChildren = [
        ebmlEl([0xd7], new Uint8Array([1])), // TrackNumber = 1
        ebmlEl([0x83], new Uint8Array([1])), // TrackType = video
        ebmlEl([0x86], new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
        ebmlEl([0x63, 0xa2], inspectedOrig.codecPrivateBytes),
      ];
      if (withEncoding) {
        trackChildren.push(
          ebmlEl([0x6d, 0x80], new Uint8Array([0x62, 0x40, 0x80])),
        );
      }
      const tracks = ebmlEl(
        [0x16, 0x54, 0xae, 0x6b],
        ebmlEl([0xae], concat(...trackChildren)),
      );
      const fillerCluster = ebmlEl(
        [0x1f, 0x43, 0xb6, 0x75],
        new Uint8Array(32),
      );

      // 先估算 SeekHead 長度，讓 SeekHead 指向放在 Cluster 後方的 Tracks
      const makeSeekHead = (pos: number) => {
        const posBytes = new Uint8Array([pos >> 8, pos & 0xff]);
        const seek = ebmlEl(
          [0x4d, 0xbb],
          concat(
            ebmlEl([0x53, 0xab], new Uint8Array([0x16, 0x54, 0xae, 0x6b])),
            ebmlEl([0x53, 0xac], posBytes),
          ),
        );
        return ebmlEl([0x11, 0x4d, 0x9b, 0x74], seek);
      };
      const shLen = makeSeekHead(0).length;
      const seekHead = makeSeekHead(shLen + fillerCluster.length);
      const segment = ebmlEl(
        [0x18, 0x53, 0x80, 0x67],
        concat(seekHead, fillerCluster, tracks),
      );
      return new Blob([concat(ebmlHeader, segment)], {
        type: "video/x-matroska",
      });
    };

    const eofTracksMkv = buildMkv(false);
    const eofInspected = await inspectHevcProfile(eofTracksMkv);
    expect(eofInspected?.container).toBe("mkv");
    expect(eofInspected?.info.mismatchMain10On8Bit).toBe(true);
    expect(eofInspected?.info.unsafeReason).toBeNull();
    const eofFix = await buildZeroCopyHevcProfileFix(
      eofTracksMkv,
      eofInspected!,
    );
    expect(eofFix.ok).toBe(true);

    const encryptedMkv = buildMkv(true);
    const encInspected = await inspectHevcProfile(encryptedMkv);
    expect(encInspected?.info.mismatchMain10On8Bit).toBe(true);
    expect(encInspected?.info.unsafeReason).toBe("mkv-content-encoding");
    const encFix = await buildZeroCopyHevcProfileFix(
      encryptedMkv,
      encInspected!,
    );
    expect(encFix).toEqual({ ok: false, reason: "mkv-content-encoding" });
  });
});
