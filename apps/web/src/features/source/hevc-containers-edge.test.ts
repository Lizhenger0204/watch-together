import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEVC_NAL_SPS,
  HEVC_PROFILE_MAIN,
  HEVC_PROFILE_MAIN_10,
  inspectSampleParameterSets,
  parseHvcc,
  rbspToEbsp,
} from "./hevc-bitstream";
import { buildZeroCopyHevcProfileFix, inspectHevcProfile } from "./hevc-header";
import { spliceZeroCopyBlob } from "./hevc-patch";

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
  if (value < 0x1fffff) {
    return new Uint8Array([
      0x20 | (value >> 16),
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
  return new Uint8Array([
    0x10 | (value >> 24),
    (value >> 16) & 0xff,
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

describe("HEVC container edge regressions (R1 review fixes)", () => {
  it("rejects overlapping or out-of-bounds patches in spliceZeroCopyBlob", () => {
    const file = new Blob([new Uint8Array(100)]);
    expect(() =>
      spliceZeroCopyBlob(
        file,
        [
          { offset: 10, length: 20, bytes: new Uint8Array(20) },
          { offset: 25, length: 10, bytes: new Uint8Array(10) },
        ],
        "video/mp4",
      ),
    ).toThrow("patch-overlap");

    expect(() =>
      spliceZeroCopyBlob(
        file,
        [{ offset: 95, length: 10, bytes: new Uint8Array(10) }],
        "video/mp4",
      ),
    ).toThrow("patch-out-of-bounds");
  });

  it("patches closely spaced MP4 in-band keyframes (< 64 KiB apart) without duplicating bytes", async () => {
    const sps = makeSyntheticSps([0x20, 0x00, 0x00, 0x00]);
    const hvcc = makeHvccWithSps(sps, 0x20);
    const vcl1 = new Uint8Array([0x26, 0x01, 0xde, 0xad, 0xbe, 0xef]);
    const vcl2 = new Uint8Array([0x26, 0x01, 0xca, 0xfe, 0xba, 0xbe]);
    const sample1 = concat(lenPrefix(sps), lenPrefix(vcl1));
    const sample2 = concat(lenPrefix(sps), lenPrefix(vcl2));

    const hev1 = mp4Box(
      "hev1",
      concat(new Uint8Array(78), mp4Box("hvcC", hvcc)),
    );
    const stsd = mp4Box("stsd", concat(u32(0), u32(1), hev1));
    const stsc = mp4Box("stsc", concat(u32(0), u32(1), u32(1), u32(2), u32(1)));
    const stsz = mp4Box(
      "stsz",
      concat(u32(0), u32(0), u32(2), u32(sample1.length), u32(sample2.length)),
    );
    const stss = mp4Box("stss", concat(u32(0), u32(2), u32(1), u32(2)));
    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isom"));
    const mdat = mp4Box("mdat", concat(sample1, sample2));

    const build = (chunkOffset: number) => {
      const stco = mp4Box("stco", concat(u32(0), u32(1), u32(chunkOffset)));
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
    const mdatPayloadOffset = ftyp.length + build(0).moov.length + 8;
    const { bytes } = build(mdatPayloadOffset);
    const blob = new Blob([bytes], { type: "video/mp4" });

    const inspected = await inspectHevcProfile(blob);
    expect(inspected?.container).toBe("mp4");
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    expect(inspected?.info.hasInBandParameterSets).toBe(true);

    const fix = await buildZeroCopyHevcProfileFix(blob, inspected!);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;

    const patched = new Uint8Array(await fix.blob.arrayBuffer());
    // 不可因 64 KiB 重疊讀取而撐大檔案或覆蓋 VCL
    expect(patched.length).toBe(bytes.length);

    const s1 = patched.subarray(
      mdatPayloadOffset,
      mdatPayloadOffset + sample1.length,
    );
    const s2 = patched.subarray(
      mdatPayloadOffset + sample1.length,
      mdatPayloadOffset + sample1.length + sample2.length,
    );
    expect(
      inspectSampleParameterSets(s1, 4).spsList[0]?.generalProfileIdc,
    ).toBe(HEVC_PROFILE_MAIN);
    expect(
      inspectSampleParameterSets(s2, 4).spsList[0]?.generalProfileIdc,
    ).toBe(HEVC_PROFILE_MAIN);
    // 驗證兩個樣本的 VCL 結尾完整保留
    expect(Array.from(s1.subarray(s1.length - 4))).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
    expect(Array.from(s2.subarray(s2.length - 4))).toEqual([
      0xca, 0xfe, 0xba, 0xbe,
    ]);
  });

  it("rebuilds variable-length moov between two mdat boxes without touching other hvcC or earlier chunks", async () => {
    const shrinkingSps = makeSyntheticSps([0x00, 0x00, 0x01, 0x80]);
    const targetHvcc = makeHvccWithSps(shrinkingSps, 0x00);
    const otherSps = makeSyntheticSps([0x20, 0x00, 0x00, 0x00]);
    const untouchedHvcc = makeHvccWithSps(otherSps, 0x20);

    const hvc1Target = mp4Box(
      "hvc1",
      concat(new Uint8Array(78), mp4Box("hvcC", targetHvcc)),
    );
    const hvc1Other = mp4Box(
      "hvc1",
      concat(new Uint8Array(78), mp4Box("hvcC", untouchedHvcc)),
    );
    const stsd = mp4Box("stsd", concat(u32(0), u32(2), hvc1Target, hvc1Other));
    const stsc = mp4Box("stsc", concat(u32(0), u32(1), u32(1), u32(1), u32(1)));
    const stsz = mp4Box("stsz", concat(u32(0), u32(4), u32(2)));

    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isom"));
    const mdat1 = mp4Box("mdat", new Uint8Array([0x11, 0x22, 0x33, 0x44]));
    const mdat2 = mp4Box("mdat", new Uint8Array([0x55, 0x66, 0x77, 0x88]));

    const mdat1Payload = ftyp.length + 8;
    const build = (off1: number, off2: number) => {
      const stco = mp4Box("stco", concat(u32(0), u32(2), u32(off1), u32(off2)));
      const moov = mp4Box(
        "moov",
        mp4Box(
          "trak",
          mp4Box(
            "mdia",
            mp4Box("minf", mp4Box("stbl", concat(stsd, stsc, stsz, stco))),
          ),
        ),
      );
      return { moov, bytes: concat(ftyp, mdat1, moov, mdat2) };
    };
    const mdat2Payload =
      ftyp.length + mdat1.length + build(0, 0).moov.length + 8;
    const { bytes } = build(mdat1Payload, mdat2Payload);
    const blob = new Blob([bytes], { type: "video/mp4" });

    const inspected = await inspectHevcProfile(blob);
    expect(inspected?.info.mismatchMain10On8Bit).toBe(true);
    const fix = await buildZeroCopyHevcProfileFix(blob, inspected!);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;

    const patched = new Uint8Array(await fix.blob.arrayBuffer());
    expect(patched.length).toBe(bytes.length - 1);

    // 確認第一個 hvcC 已改為 Main，第二個 hvcC 保持原狀 Main 10
    const foundHvccProfiles: number[] = [];
    for (let i = 4; i + 27 <= patched.length; i += 1) {
      if (
        patched[i] === 0x68 &&
        patched[i + 1] === 0x76 &&
        patched[i + 2] === 0x63 &&
        patched[i + 3] === 0x43
      ) {
        const boxSize = new DataView(patched.buffer).getUint32(i - 4, false);
        const parsed = parseHvcc(patched.subarray(i + 4, i - 4 + boxSize));
        if (parsed) foundHvccProfiles.push(parsed.generalProfileIdc);
      }
    }
    expect(foundHvccProfiles).toEqual([
      HEVC_PROFILE_MAIN,
      HEVC_PROFILE_MAIN_10,
    ]);

    // 確認 stco[0]（mdat1，在 moov 前）不變；stco[1]（mdat2，在 moov 後）平移 -1
    const view = new DataView(patched.buffer);
    let stcoPos = -1;
    for (let i = 0; i + 24 <= patched.length; i += 1) {
      if (
        patched[i + 4] === 0x73 &&
        patched[i + 5] === 0x74 &&
        patched[i + 6] === 0x63 &&
        patched[i + 7] === 0x6f
      ) {
        stcoPos = i;
        break;
      }
    }
    expect(stcoPos).toBeGreaterThan(0);
    const off1 = view.getUint32(stcoPos + 16, false);
    const off2 = view.getUint32(stcoPos + 20, false);
    expect(off1).toBe(mdat1Payload);
    expect(off2).toBe(mdat2Payload - 1);
    expect(patched[off1]).toBe(0x11);
    expect(patched[off2]).toBe(0x55);
  });

  it("patches second MKV keyframe > 20 KiB into the same Cluster via CueRelativePosition, and refuses large MKV missing it", async () => {
    const malformedMkv = readFileSync(
      resolve(FIXTURES_DIR, "hevc-main10-8bit-malformed-aac.mkv"),
    );
    const origInspected = await inspectHevcProfile(
      new Blob([malformedMkv], { type: "video/x-matroska" }),
    );
    expect(origInspected?.container).toBe("mkv");
    if (!origInspected || origInspected.container !== "mkv") return;

    const sps = makeSyntheticSps([0x20, 0x00, 0x00, 0x00]);
    const vcl = new Uint8Array([0x26, 0x01, 0xab, 0xcd]);
    const kfPayload = concat(lenPrefix(sps), lenPrefix(vcl));

    const makeSimpleBlock = (
      trackNum: number,
      flags: number,
      body: Uint8Array,
    ) =>
      ebmlEl(
        [0xa3],
        concat(new Uint8Array([0x80 | trackNum, 0x00, 0x00, flags]), body),
      );

    const kf1 = makeSimpleBlock(1, 0x80, kfPayload);
    // 中間放一個 20,500 bytes 的非關鍵幀，使第二個關鍵幀遠超 16 KiB 探測視窗
    const bigInter = makeSimpleBlock(1, 0x00, new Uint8Array(20_500));
    const kf2 = makeSimpleBlock(1, 0x80, kfPayload);
    const clusterTimecode = ebmlEl([0xe7], new Uint8Array([0x00]));

    const relPos1 = clusterTimecode.length;
    const relPos2 = clusterTimecode.length + kf1.length + bigInter.length;
    expect(relPos2).toBeGreaterThan(20_000);

    const cluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(clusterTimecode, kf1, bigInter, kf2),
    );
    const tracks = ebmlEl(
      [0x16, 0x54, 0xae, 0x6b],
      ebmlEl(
        [0xae],
        concat(
          ebmlEl([0xd7], new Uint8Array([1])),
          ebmlEl([0x83], new Uint8Array([1])),
          ebmlEl([0x86], new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
          ebmlEl([0x63, 0xa2], origInspected.codecPrivateBytes),
        ),
      ),
    );

    const u16be = (v: number) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
    const makeCuePoint = (clusterPos: number, relPos?: number) => {
      const fields = [
        ebmlEl([0xf7], new Uint8Array([1])),
        ebmlEl([0xf1], u16be(clusterPos)),
      ];
      if (relPos !== undefined) fields.push(ebmlEl([0xf0], u16be(relPos)));
      return ebmlEl([0xbb], ebmlEl([0xb7], concat(...fields)));
    };

    const ebmlHeader = ebmlEl(
      [0x1a, 0x45, 0xdf, 0xa3],
      new Uint8Array([0x42, 0x86, 0x81, 0x01]),
    );

    // 情境 A：Cues 含 CueRelativePosition → 同 Cluster 相距 > 20 KiB 的兩個關鍵幀都修成 Main
    const cuesWithRel = ebmlEl(
      [0x1c, 0x53, 0xbb, 0x6b],
      concat(
        makeCuePoint(tracks.length, relPos1),
        makeCuePoint(tracks.length, relPos2),
      ),
    );
    const mkvWithRel = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl(
            [0x18, 0x53, 0x80, 0x67],
            concat(tracks, cluster, cuesWithRel),
          ),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const insRel = await inspectHevcProfile(mkvWithRel);
    expect(insRel?.info.mismatchMain10On8Bit).toBe(true);
    const fixRel = await buildZeroCopyHevcProfileFix(mkvWithRel, insRel!);
    expect(fixRel.ok).toBe(true);
    if (!fixRel.ok) return;
    expect(fixRel.patchedRanges).toBe(3);

    const patchedBytes = new Uint8Array(await fixRel.blob.arrayBuffer());
    expect(patchedBytes.length).toBe(mkvWithRel.size);
    // 檢查兩個關鍵幀在輸出中的 in-band SPS 皆已改為 Main（1），不可殘留 Main 10（2）
    const foundProfiles: number[] = [];
    for (let i = 0; i + 8 < patchedBytes.length; i += 1) {
      if (
        patchedBytes[i] === 0 &&
        patchedBytes[i + 1] === 0 &&
        patchedBytes[i + 2] === 0 &&
        patchedBytes[i + 3] === sps.length &&
        ((patchedBytes[i + 4]! >> 1) & 0x3f) === HEVC_NAL_SPS
      ) {
        const res = inspectSampleParameterSets(
          patchedBytes.subarray(i, i + 4 + sps.length),
          4,
        );
        if (res.spsList[0])
          foundProfiles.push(res.spsList[0].generalProfileIdc);
      }
    }
    expect(foundProfiles).toEqual([HEVC_PROFILE_MAIN, HEVC_PROFILE_MAIN]);

    // 情境 B：大檔（> 4 MB）含 in-band VPS/SPS → 即使有 Cues 也不保證涵蓋同 Cluster 內全部關鍵幀，必須降級
    const cuesNoRel = ebmlEl(
      [0x1c, 0x53, 0xbb, 0x6b],
      concat(makeCuePoint(tracks.length)),
    );
    // 把 Cues 放在 Cluster 之前、並在檔尾加 4.5 MB 填充，模擬大檔
    const padSize = 4_500_000;
    const cuesBeforeCluster = ebmlEl(
      [0x1c, 0x53, 0xbb, 0x6b],
      makeCuePoint(tracks.length + cuesNoRel.length),
    );
    const segPrefix = concat(
      new Uint8Array([
        0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ]),
      tracks,
      cuesBeforeCluster,
      cluster,
    );
    const largeMkv = new Blob(
      [ebmlHeader, segPrefix, new Uint8Array(padSize)],
      {
        type: "video/x-matroska",
      },
    );
    const insLarge = await inspectHevcProfile(largeMkv);
    expect(insLarge?.info.mismatchMain10On8Bit).toBe(true);
    expect(insLarge?.info.hasInBandParameterSets).toBe(true);
    const fixLarge = await buildZeroCopyHevcProfileFix(largeMkv, insLarge!);
    expect(fixLarge).toEqual({
      ok: false,
      reason: "mkv-inband-unverified-coverage",
    });

    // 情境 C：含 in-band VPS/SPS 的 MKV 遇到 lacing block → 明確降級拒改
    const lacedBlock = makeSimpleBlock(1, 0x82, kfPayload);
    const lacedCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(clusterTimecode, kf1, lacedBlock),
    );
    const lacedMkv = new Blob(
      [
        concat(
          ebmlHeader,
          ebmlEl([0x18, 0x53, 0x80, 0x67], concat(tracks, lacedCluster)),
        ),
      ],
      { type: "video/x-matroska" },
    );
    const insLaced = await inspectHevcProfile(lacedMkv);
    expect(insLaced?.info.mismatchMain10On8Bit).toBe(true);
    const fixLaced = await buildZeroCopyHevcProfileFix(lacedMkv, insLaced!);
    expect(fixLaced).toEqual({ ok: false, reason: "mkv-inband-laced-block" });
  });
});
