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
  EBML_ID_CRC32,
  EBML_ID_TRACK_ENTRY,
  computeEbmlCrc32,
} from "./hevc-ebml";
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

function ebmlMasterWithCrc(
  idBytes: number[],
  bodyPayload: Uint8Array,
  corruptBit = false,
): Uint8Array<ArrayBuffer> {
  const crc = computeEbmlCrc32([bodyPayload]) ^ (corruptBit ? 1 : 0);
  const crcBytes = new Uint8Array(4);
  new DataView(crcBytes.buffer).setUint32(0, crc >>> 0, true);
  return ebmlEl(
    idBytes,
    concat(ebmlEl([EBML_ID_CRC32], crcBytes), bodyPayload),
  );
}

function makeSyntheticSps(options?: {
  compatBytes?: [number, number, number, number];
  maxSubLayersMinus1?: number;
  subLayerProfileIdc?: number;
}) {
  const {
    compatBytes = [0x20, 0x00, 0x00, 0x00],
    maxSubLayersMinus1 = 0,
    subLayerProfileIdc,
  } = options ?? {};
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
  for (const b of compatBytes) pushBits(b, 8);
  for (let i = 0; i < 6; i += 1) pushBits(0, 8);
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

describe("HEVC container regressions (R3 review fixes)", () => {
  it("refuses variable-length moov rebuild on fragmented MP4 (mvex/moof)", async () => {
    const shrinkingSps = makeSyntheticSps({
      compatBytes: [0x00, 0x00, 0x01, 0x80],
    });
    const hvcc = makeHvccWithSps(shrinkingSps, 0x00);
    const hvc1 = mp4Box(
      "hvc1",
      concat(new Uint8Array(78), mp4Box("hvcC", hvcc)),
    );
    const stsd = mp4Box("stsd", concat(u32(0), u32(1), hvc1));
    const stsc = mp4Box("stsc", concat(u32(0), u32(0)));
    const stsz = mp4Box("stsz", concat(u32(0), u32(0), u32(0)));
    const stco = mp4Box("stco", concat(u32(0), u32(0)));
    const mvex = mp4Box("mvex", mp4Box("trex", new Uint8Array(24)));
    const moov = mp4Box(
      "moov",
      concat(
        mp4Box(
          "trak",
          mp4Box(
            "mdia",
            mp4Box("minf", mp4Box("stbl", concat(stsd, stsc, stsz, stco))),
          ),
        ),
        mvex,
      ),
    );
    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isom"));
    const moof = mp4Box("moof", new Uint8Array(16));
    const mdat = mp4Box(
      "mdat",
      new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x26, 0x01, 0xaa, 0xbb]),
    );
    const blob = new Blob([concat(ftyp, moov, moof, mdat)], {
      type: "video/mp4",
    });

    const inspected = await inspectHevcProfile(blob);
    expect(inspected?.container).toBe("mp4");
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    const fix = await buildZeroCopyHevcProfileFix(blob, inspected!);
    expect(fix).toEqual({
      ok: false,
      reason: "mp4-fragmented-variable-length",
    });
  });

  it("patches unprobed late-frame in-band SPS in hev1 MP4 and rejects late-frame sub-layer Main 10 SPS", async () => {
    const sps = makeSyntheticSps();
    const subLayerSps = makeSyntheticSps({
      maxSubLayersMinus1: 1,
      subLayerProfileIdc: HEVC_PROFILE_MAIN_10,
    });
    const hvcc = makeHvccWithSps(sps, 0x20);
    const vcl = new Uint8Array([0x26, 0x01, 0xca, 0xfe]);

    const buildHev1Mp4 = (lateSample: Uint8Array) => {
      // 前 2 個關鍵幀沒有 in-band SPS，只有第 3 個（探測 [0, 1] 沒讀到）才帶 in-band SPS
      const s1 = lenPrefix(vcl);
      const s2 = lenPrefix(vcl);
      const s3 = lateSample;
      const hev1 = mp4Box(
        "hev1",
        concat(new Uint8Array(78), mp4Box("hvcC", hvcc)),
      );
      const stsd = mp4Box("stsd", concat(u32(0), u32(1), hev1));
      const stsc = mp4Box(
        "stsc",
        concat(u32(0), u32(1), u32(1), u32(3), u32(1)),
      );
      const stsz = mp4Box(
        "stsz",
        concat(
          u32(0),
          u32(0),
          u32(3),
          u32(s1.length),
          u32(s2.length),
          u32(s3.length),
        ),
      );
      const stss = mp4Box(
        "stss",
        concat(u32(0), u32(3), u32(1), u32(2), u32(3)),
      );
      const ftyp = mp4Box(
        "ftyp",
        new TextEncoder().encode("isom\0\0\x02\0isom"),
      );
      const mdat = mp4Box("mdat", concat(s1, s2, s3));
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
      return {
        s3Offset: mdatStart + s1.length + s2.length,
        s3Len: s3.length,
        bytes: make(mdatStart).bytes,
      };
    };

    // 案例 A：未抽查到的第 3 幀帶標準 8-bit Main 10 SPS → hev1 MP4 必須完整掃描並修補
    const goodLate = buildHev1Mp4(concat(lenPrefix(sps), lenPrefix(vcl)));
    const goodBlob = new Blob([goodLate.bytes], { type: "video/mp4" });
    const goodInsp = await inspectHevcProfile(goodBlob);
    expect(goodInsp?.info.mismatchMain10On8Bit).toBe(true);
    expect(goodInsp?.info.hasInBandParameterSets).toBe(false);
    const goodFix = await buildZeroCopyHevcProfileFix(goodBlob, goodInsp!);
    expect(goodFix.ok).toBe(true);
    if (!goodFix.ok) return;
    const goodOut = new Uint8Array(await goodFix.blob.arrayBuffer());
    expect(
      inspectSampleParameterSets(
        goodOut.subarray(goodLate.s3Offset, goodLate.s3Offset + goodLate.s3Len),
        4,
      ).spsList[0]?.generalProfileIdc,
    ).toBe(HEVC_PROFILE_MAIN);

    // 案例 B：未抽查到的第 3 幀帶 Main 10 sub-layer SPS → 必須在寫入前被安全規則拒改
    const subLate = buildHev1Mp4(
      concat(lenPrefix(subLayerSps), lenPrefix(vcl)),
    );
    const subBlob = new Blob([subLate.bytes], { type: "video/mp4" });
    const subInsp = await inspectHevcProfile(subBlob);
    expect(subInsp?.info.mismatchMain10On8Bit).toBe(true);
    const subFix = await buildZeroCopyHevcProfileFix(subBlob, subInsp!);
    expect(subFix).toEqual({ ok: false, reason: "sub-layer-main10" });
  });

  it("handles unprobed late MKV in-band SPS, rejects late sub-layer Main 10, corrupt CRC-32, truncated CRC-32, and unknown-size Block", async () => {
    const malformedMkv = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-malformed-aac.mkv"),
    );
    const origInsp = await inspectHevcProfile(
      new Blob([malformedMkv], { type: "video/x-matroska" }),
    );
    if (!origInsp || origInsp.container !== "mkv")
      throw new Error("expected mkv");

    const sps = makeSyntheticSps();
    const subLayerSps = makeSyntheticSps({
      maxSubLayersMinus1: 1,
      subLayerProfileIdc: HEVC_PROFILE_MAIN_10,
    });
    const vcl = new Uint8Array([0x26, 0x01, 0xaa, 0xbb]);
    const ebmlHeader = ebmlEl(
      [0x1a, 0x45, 0xdf, 0xa3],
      new Uint8Array([0x42, 0x86, 0x81, 0x01]),
    );
    const makeTrackEntryBody = () =>
      concat(
        ebmlEl([0xd7], new Uint8Array([1])),
        ebmlEl([0x83], new Uint8Array([1])),
        ebmlEl([0x86], new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
        ebmlEl([0x63, 0xa2], origInsp.codecPrivateBytes),
      );
    const validTracks = ebmlMasterWithCrc(
      [0x16, 0x54, 0xae, 0x6b],
      ebmlMasterWithCrc([EBML_ID_TRACK_ENTRY], makeTrackEntryBody()),
    );
    const makeBlock = (body: Uint8Array) =>
      ebmlEl([0xa3], concat(new Uint8Array([0x81, 0x00, 0x00, 0x80]), body));
    const tc = (n: number) => ebmlEl([0xe7], new Uint8Array([n]));

    // 1. 小型 MKV 首 Cluster 無 in-band，第二 Cluster 才有 → 必須完整走訪並修補
    const c1Clean = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tc(0), makeBlock(lenPrefix(vcl))),
    );
    const c2Late = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tc(1), makeBlock(concat(lenPrefix(sps), lenPrefix(vcl)))),
    );
    const lateMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl(
            [0x18, 0x53, 0x80, 0x67],
            concat(validTracks, c1Clean, c2Late),
          ),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const lateInsp = await inspectHevcProfile(lateMkv);
    expect(lateInsp?.info.hasInBandParameterSets).toBe(false);
    const lateFix = await buildZeroCopyHevcProfileFix(lateMkv, lateInsp!);
    expect(lateFix.ok).toBe(true);
    if (!lateFix.ok) return;
    const lateOut = new Uint8Array(await lateFix.blob.arrayBuffer());
    const lateProfiles: number[] = [];
    for (let i = 0; i + 4 + sps.length <= lateOut.length; i += 1) {
      if (
        lateOut[i] === 0 &&
        lateOut[i + 1] === 0 &&
        lateOut[i + 2] === 0 &&
        lateOut[i + 3] === sps.length &&
        ((lateOut[i + 4]! >> 1) & 0x3f) === HEVC_NAL_SPS
      ) {
        const r = inspectSampleParameterSets(
          lateOut.subarray(i, i + 4 + sps.length),
          4,
        );
        if (r.spsList[0]) lateProfiles.push(r.spsList[0].generalProfileIdc);
      }
    }
    expect(lateProfiles).toEqual([HEVC_PROFILE_MAIN]);

    // 2. 小型 MKV 第二 Cluster 出現帶 Main 10 sub-layer 的 SPS → 必須拒絕
    const c2Sub = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tc(1), makeBlock(concat(lenPrefix(subLayerSps), lenPrefix(vcl)))),
    );
    const subMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl([0x18, 0x53, 0x80, 0x67], concat(validTracks, c1Clean, c2Sub)),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const subInsp = await inspectHevcProfile(subMkv);
    const subFix = await buildZeroCopyHevcProfileFix(subMkv, subInsp!);
    expect(subFix).toEqual({ ok: false, reason: "sub-layer-main10" });

    // 3. TrackEntry 原 CRC-32 翻轉 1 bit → 拒絕覆寫已損毀的 CRC
    const corruptEntry = ebmlMasterWithCrc(
      [EBML_ID_TRACK_ENTRY],
      makeTrackEntryBody(),
      true,
    );
    const corruptTracks = ebmlMasterWithCrc(
      [0x16, 0x54, 0xae, 0x6b],
      corruptEntry,
    );
    const corruptCrcMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl([0x18, 0x53, 0x80, 0x67], concat(corruptTracks, c1Clean)),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const corruptCrcInsp = await inspectHevcProfile(corruptCrcMkv);
    expect(corruptCrcInsp?.info.mismatchMain10On8Bit).toBe(true);
    const corruptCrcFix = await buildZeroCopyHevcProfileFix(
      corruptCrcMkv,
      corruptCrcInsp!,
    );
    expect(corruptCrcFix).toEqual({
      ok: false,
      reason: "mkv-original-crc32-invalid",
    });

    // 4. CRC-32 宣告 5 bytes 但容器僅剩 4 bytes → 嚴格邊界檢查拒絕
    const badCrcEntry = ebmlEl(
      [EBML_ID_TRACK_ENTRY],
      concat(
        makeTrackEntryBody(),
        new Uint8Array([0xbf, 0x85, 0x01, 0x02, 0x03, 0x04]),
      ),
    );
    const badCrcMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl(
            [0x18, 0x53, 0x80, 0x67],
            concat(ebmlEl([0x16, 0x54, 0xae, 0x6b], badCrcEntry), c1Clean),
          ),
        ),
      ],
      { type: "video/x-matroska" },
    );
    // 嚴格解析 Tracks/TrackEntry 時即拒絕越界 CRC 元素
    expect(await inspectHevcProfile(badCrcMkv)).toBeNull();

    // 5. BlockGroup 內含未知長度 Block（0xA1 0xFF）→ 必須拒絕
    const unknownBlockGroup = ebmlEl(
      [0xa0],
      concat(
        new Uint8Array([0xa1, 0xff, 0x81, 0x00, 0x00, 0x00]),
        lenPrefix(vcl),
      ),
    );
    const cBadBg = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tc(0), unknownBlockGroup),
    );
    const badBgMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl([0x18, 0x53, 0x80, 0x67], concat(validTracks, cBadBg)),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const badBgInsp = await inspectHevcProfile(badBgMkv);
    const badBgFix = await buildZeroCopyHevcProfileFix(badBgMkv, badBgInsp!);
    expect(badBgFix).toEqual({ ok: false, reason: "mkv-corrupt-block-group" });
  });
});
