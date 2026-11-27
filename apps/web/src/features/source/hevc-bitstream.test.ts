import { describe, expect, it } from "vitest";
import {
  classifyHevcHeader,
  ebspToRbsp,
  hasForbiddenStartCode,
  HEVC_NAL_SPS,
  HEVC_NAL_VPS,
  HEVC_PROFILE_MAIN,
  HEVC_PROFILE_MAIN_10,
  inspectSampleParameterSets,
  parseHevcSps,
  parseHvcc,
  rbspToEbsp,
} from "./hevc-bitstream";
import {
  patchHevcParameterSetNalu,
  patchHvccRecord,
  patchSampleParameterSets,
} from "./hevc-patch";

/** 建立最小合法 HEVC SPS NALU（可控制 profile_space / profile_idc / compat / chroma / bitDepth / sub-layer）。 */
function buildSyntheticSps(options?: {
  profileSpace?: number;
  profileIdc?: number;
  compatB1?: number;
  compatRest?: [number, number, number];
  chromaFormatIdc?: number;
  bitDepthLumaMinus8?: number;
  bitDepthChromaMinus8?: number;
  maxSubLayersMinus1?: number;
  subLayerProfileIdc?: number;
}): Uint8Array {
  const {
    profileSpace = 0,
    profileIdc = HEVC_PROFILE_MAIN_10,
    compatB1 = 0x20,
    compatRest = [0x00, 0x00, 0x00],
    chromaFormatIdc = 1,
    bitDepthLumaMinus8 = 0,
    bitDepthChromaMinus8 = 0,
    maxSubLayersMinus1 = 0,
    subLayerProfileIdc,
  } = options ?? {};

  const bits: number[] = [];
  const pushBits = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  const pushUE = (val: number) => {
    const codeNum = val + 1;
    const len = Math.floor(Math.log2(codeNum));
    for (let i = 0; i < len; i += 1) bits.push(0);
    pushBits(codeNum, len + 1);
  };

  // sps_video_parameter_set_id(4), sps_max_sub_layers_minus1(3), sps_temporal_id_nesting_flag(1)
  pushBits(0, 4);
  pushBits(maxSubLayersMinus1, 3);
  pushBits(1, 1);

  // profile_tier_level
  pushBits(profileSpace, 2);
  pushBits(0, 1);
  pushBits(profileIdc, 5);
  pushBits(compatB1, 8);
  pushBits(compatRest[0], 8);
  pushBits(compatRest[1], 8);
  pushBits(compatRest[2], 8);
  // 48 bits constraint flags
  for (let i = 0; i < 6; i += 1) pushBits(0, 8);
  // general_level_idc = 93
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

  // sps_seq_parameter_set_id = 0
  pushUE(0);
  // chroma_format_idc
  pushUE(chromaFormatIdc);
  if (chromaFormatIdc === 3) pushBits(0, 1);
  // pic_width / pic_height
  pushUE(160);
  pushUE(96);
  // conformance_window_flag = 0
  pushBits(0, 1);
  // bit_depth_luma_minus8 / bit_depth_chroma_minus8
  pushUE(bitDepthLumaMinus8);
  pushUE(bitDepthChromaMinus8);
  // trailing RBSP stop bit
  pushBits(1, 1);
  while (bits.length % 8 !== 0) bits.push(0);

  const rbsp = new Uint8Array(bits.length / 8);
  for (let i = 0; i < rbsp.length; i += 1) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i * 8 + b]!;
    rbsp[i] = byte;
  }

  const ebsp = rbspToEbsp(rbsp);
  const nalu = new Uint8Array(2 + ebsp.length);
  nalu[0] = (HEVC_NAL_SPS << 1) & 0x7e;
  nalu[1] = 0x01;
  nalu.set(ebsp, 2);
  return nalu;
}

function buildSyntheticVps(profileIdc = HEVC_PROFILE_MAIN_10, compatB1 = 0x20) {
  const rbsp = new Uint8Array(20);
  rbsp[0] = 0x0c;
  rbsp[1] = 0x01;
  rbsp[2] = 0xff;
  rbsp[3] = 0xff;
  rbsp[4] = profileIdc & 0x1f;
  rbsp[5] = compatB1;
  rbsp[15] = 93;
  rbsp[19] = 0x80;
  const ebsp = rbspToEbsp(rbsp);
  const nalu = new Uint8Array(2 + ebsp.length);
  nalu[0] = (HEVC_NAL_VPS << 1) & 0x7e;
  nalu[1] = 0x01;
  nalu.set(ebsp, 2);
  return nalu;
}

function buildSyntheticHvcc(options: {
  profileSpace?: number;
  profileIdc?: number;
  compatB1?: number;
  chromaFormat?: number;
  bitDepthLumaMinus8?: number;
  bitDepthChromaMinus8?: number;
  vps?: Uint8Array;
  sps?: Uint8Array;
}): Uint8Array {
  const {
    profileSpace = 0,
    profileIdc = HEVC_PROFILE_MAIN_10,
    compatB1 = 0x20,
    chromaFormat = 1,
    bitDepthLumaMinus8 = 0,
    bitDepthChromaMinus8 = 0,
    vps,
    sps,
  } = options;
  const arrays: { type: number; nalu: Uint8Array }[] = [];
  if (vps) arrays.push({ type: HEVC_NAL_VPS, nalu: vps });
  if (sps) arrays.push({ type: HEVC_NAL_SPS, nalu: sps });

  const totalLen =
    23 + arrays.reduce((sum, item) => sum + 3 + 2 + item.nalu.length, 0);
  const out = new Uint8Array(totalLen);
  out[0] = 1;
  out[1] = ((profileSpace & 0x03) << 6) | (profileIdc & 0x1f);
  out[2] = compatB1;
  out[12] = 93;
  out[16] = 0xfc | (chromaFormat & 0x03);
  out[17] = 0xf8 | (bitDepthLumaMinus8 & 0x07);
  out[18] = 0xf8 | (bitDepthChromaMinus8 & 0x07);
  out[21] = 0x03; // 4-byte NAL length prefix
  out[22] = arrays.length;

  let pos = 23;
  for (const item of arrays) {
    out[pos] = 0x80 | item.type;
    out[pos + 1] = 0;
    out[pos + 2] = 1;
    out[pos + 3] = (item.nalu.length >> 8) & 0xff;
    out[pos + 4] = item.nalu.length & 0xff;
    out.set(item.nalu, pos + 5);
    pos += 5 + item.nalu.length;
  }
  return out;
}

describe("hevc bitstream & profile patching", () => {
  it("round-trips emulation prevention bytes and rejects forbidden sequences", () => {
    const rbsp = new Uint8Array([
      0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x03, 0x05,
    ]);
    const ebsp = rbspToEbsp(rbsp);
    expect(hasForbiddenStartCode(ebsp)).toBe(false);
    expect(Array.from(ebspToRbsp(ebsp))).toEqual(Array.from(rbsp));

    expect(hasForbiddenStartCode(new Uint8Array([0x00, 0x00, 0x00]))).toBe(
      true,
    );
    expect(hasForbiddenStartCode(new Uint8Array([0x00, 0x00, 0x01]))).toBe(
      true,
    );
    expect(hasForbiddenStartCode(new Uint8Array([0x00, 0x00, 0x02]))).toBe(
      true,
    );
    expect(
      hasForbiddenStartCode(new Uint8Array([0x00, 0x00, 0x03, 0x04])),
    ).toBe(true);
    expect(hasForbiddenStartCode(new Uint8Array([0x00, 0x00, 0x03]))).toBe(
      true,
    );
  });

  it("handles EPB removal cleanly when oldB1 is 0x00 followed by 0x00 0x01", () => {
    // 當 compat 為 [0x00, 0x00, 0x01, 0x80] 時，原 EBSP 為 00 00 [03] 01 80；
    // 改寫 compatB1 為 0x40 後變成 40 00 01 80，0x03 消失、NALU 縮短 1 位元組且不含非法序列。
    const sps = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      compatB1: 0x00,
      compatRest: [0x00, 0x01, 0x80],
    });
    const res = patchHevcParameterSetNalu(sps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(res.sameLength).toBe(false);
    expect(res.patched.length).toBe(sps.length - 1);
    expect(hasForbiddenStartCode(res.patched.subarray(2))).toBe(false);
    const reparsed = parseHevcSps(res.patched);
    expect(reparsed).toMatchObject({
      generalProfileIdc: HEVC_PROFILE_MAIN,
      bitDepthLumaMinus8: 0,
      bitDepthChromaMinus8: 0,
    });
  });

  it("patches standard Main 10 on 8-bit VPS/SPS in-place with identical length", () => {
    const vps = buildSyntheticVps(HEVC_PROFILE_MAIN_10, 0x20);
    const sps = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      compatB1: 0x20,
    });
    const hvcc = buildSyntheticHvcc({
      profileIdc: HEVC_PROFILE_MAIN_10,
      compatB1: 0x20,
      vps,
      sps,
    });

    const patched = patchHvccRecord(hvcc);
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.sameLength).toBe(true);
    expect(patched.patchedNalus).toBe(2);

    const parsed = parseHvcc(patched.patched);
    expect(parsed).not.toBeNull();
    expect(parsed!.generalProfileIdc).toBe(HEVC_PROFILE_MAIN);
    expect(parsed!.parsedSpsList[0]?.generalProfileIdc).toBe(HEVC_PROFILE_MAIN);
  });

  it("classifies normal Main 8, true Main 10, and malformed Main 10 on 8-bit without cross-misjudgment", () => {
    const main8 = parseHvcc(
      buildSyntheticHvcc({
        profileIdc: HEVC_PROFILE_MAIN,
        compatB1: 0x60,
        sps: buildSyntheticSps({
          profileIdc: HEVC_PROFILE_MAIN,
          compatB1: 0x60,
        }),
      }),
    )!;
    expect(classifyHevcHeader("mp4", main8, [], false)).toMatchObject({
      declaredProfileIdc: HEVC_PROFILE_MAIN,
      bitDepthLuma: 8,
      mismatchMain10On8Bit: false,
      unsafeReason: null,
    });

    const trueMain10 = parseHvcc(
      buildSyntheticHvcc({
        profileIdc: HEVC_PROFILE_MAIN_10,
        bitDepthLumaMinus8: 2,
        bitDepthChromaMinus8: 2,
        sps: buildSyntheticSps({
          profileIdc: HEVC_PROFILE_MAIN_10,
          bitDepthLumaMinus8: 2,
          bitDepthChromaMinus8: 2,
        }),
      }),
    )!;
    expect(classifyHevcHeader("mp4", trueMain10, [], false)).toMatchObject({
      declaredProfileIdc: HEVC_PROFILE_MAIN_10,
      bitDepthLuma: 10,
      bitDepthChroma: 10,
      mismatchMain10On8Bit: false,
      unsafeReason: null,
    });

    const malformed = parseHvcc(
      buildSyntheticHvcc({
        profileIdc: HEVC_PROFILE_MAIN_10,
        bitDepthLumaMinus8: 0,
        bitDepthChromaMinus8: 0,
        sps: buildSyntheticSps({
          profileIdc: HEVC_PROFILE_MAIN_10,
          bitDepthLumaMinus8: 0,
          bitDepthChromaMinus8: 0,
        }),
      }),
    )!;
    expect(classifyHevcHeader("mp4", malformed, [], false)).toMatchObject({
      declaredProfileIdc: HEVC_PROFILE_MAIN_10,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
      mismatchMain10On8Bit: true,
      unsafeReason: null,
    });
  });

  it("flags strict safety boundaries (sub-layer Main 10, non-4:2:0, non-zero profile_space, missing SPS)", () => {
    const subLayerMain10 = parseHvcc(
      buildSyntheticHvcc({
        profileIdc: HEVC_PROFILE_MAIN_10,
        sps: buildSyntheticSps({
          profileIdc: HEVC_PROFILE_MAIN_10,
          maxSubLayersMinus1: 1,
          subLayerProfileIdc: HEVC_PROFILE_MAIN_10,
        }),
      }),
    )!;
    const subLayerClassified = classifyHevcHeader(
      "mp4",
      subLayerMain10,
      [],
      false,
    );
    expect(subLayerClassified.mismatchMain10On8Bit).toBe(false);
    expect(subLayerClassified.unsafeReason).toBe("sub-layer-main10");

    const non420 = parseHvcc(
      buildSyntheticHvcc({
        profileIdc: HEVC_PROFILE_MAIN_10,
        chromaFormat: 2,
        sps: buildSyntheticSps({
          profileIdc: HEVC_PROFILE_MAIN_10,
          chromaFormatIdc: 2,
        }),
      }),
    )!;
    const non420Classified = classifyHevcHeader("mp4", non420, [], false);
    expect(non420Classified.mismatchMain10On8Bit).toBe(false);
    expect(non420Classified.unsafeReason).toBe("non-420-chroma");

    const nonZeroSpace = parseHvcc(
      buildSyntheticHvcc({
        profileSpace: 1,
        profileIdc: HEVC_PROFILE_MAIN_10,
        sps: buildSyntheticSps({
          profileSpace: 1,
          profileIdc: HEVC_PROFILE_MAIN_10,
        }),
      }),
    )!;
    const nonZeroSpaceClassified = classifyHevcHeader(
      "mp4",
      nonZeroSpace,
      [],
      false,
    );
    expect(nonZeroSpaceClassified.mismatchMain10On8Bit).toBe(false);
    expect(nonZeroSpaceClassified.declaredProfileName).not.toBe("Main 10");
    expect(nonZeroSpaceClassified.unsafeReason).toBe("non-zero-profile-space");

    const missingSps = parseHvcc(
      buildSyntheticHvcc({ profileIdc: HEVC_PROFILE_MAIN_10 }),
    )!;
    const missingClassified = classifyHevcHeader("mp4", missingSps, [], false);
    expect(missingClassified.mismatchMain10On8Bit).toBe(false);
    expect(missingClassified.unsafeReason).toBe("missing-sps");

    // 混合 8-bit 與 10-bit SPS（不論都在 hvcC 或 hvcC＋in-band），不可確診為「實際 8-bit」
    const sps8 = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      bitDepthLumaMinus8: 0,
      bitDepthChromaMinus8: 0,
    });
    const sps10 = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      bitDepthLumaMinus8: 2,
      bitDepthChromaMinus8: 2,
    });
    const hvccWith8 = parseHvcc(
      buildSyntheticHvcc({ profileIdc: HEVC_PROFILE_MAIN_10, sps: sps8 }),
    )!;
    const mixedClassified = classifyHevcHeader(
      "mp4",
      hvccWith8,
      [parseHevcSps(sps10)!],
      true,
    );
    expect(mixedClassified.mismatchMain10On8Bit).toBe(false);
    expect(mixedClassified.bitDepthLuma).toBe(10);

    // 含有無法解析的 SPS 時不可確診為「實際 8-bit」
    const unparsedClassified = classifyHevcHeader(
      "mp4",
      hvccWith8,
      [],
      true,
      null,
      true,
    );
    expect(unparsedClassified.mismatchMain10On8Bit).toBe(false);
    expect(unparsedClassified.unsafeReason).toBe("unparsed-sps");
  });

  it("rejects input SPS containing forbidden EPB sequence 00 00 03 04 before stripping EPB", () => {
    const validSps = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      compatB1: 0x20,
    });
    // 在結尾插入非法序列 00 00 03 04
    const illegalSps = new Uint8Array(validSps.length + 4);
    illegalSps.set(validSps, 0);
    illegalSps.set([0x00, 0x00, 0x03, 0x04], validSps.length);

    expect(hasForbiddenStartCode(illegalSps.subarray(2))).toBe(true);
    expect(parseHevcSps(illegalSps)).toBeNull();
    expect(patchHevcParameterSetNalu(illegalSps)).toEqual({
      ok: false,
      reason: "input-epb-invalid",
    });
  });

  it("inspects and patches length-prefixed in-band VPS/SPS before a VCL slice", () => {
    const vps = buildSyntheticVps(HEVC_PROFILE_MAIN_10, 0x20);
    const sps = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      compatB1: 0x20,
    });
    const slice = new Uint8Array([0x26, 0x01, 0xaa, 0xbb, 0xcc]); // IDR_W_RADL (19)

    const pack = (nalu: Uint8Array) => {
      const out = new Uint8Array(4 + nalu.length);
      new DataView(out.buffer).setUint32(0, nalu.length, false);
      out.set(nalu, 4);
      return out;
    };
    const sample = new Uint8Array(
      4 + vps.length + 4 + sps.length + 4 + slice.length,
    );
    sample.set(pack(vps), 0);
    sample.set(pack(sps), 4 + vps.length);
    sample.set(pack(slice), 4 + vps.length + 4 + sps.length);

    const inspected = inspectSampleParameterSets(sample, 4);
    expect(inspected.hasInBandParameterSets).toBe(true);
    expect(inspected.spsList).toHaveLength(1);
    expect(inspected.spsList[0]?.generalProfileIdc).toBe(HEVC_PROFILE_MAIN_10);

    const patched = patchSampleParameterSets(sample, 4);
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.changed).toBe(true);
    expect(patched.sameLength).toBe(true);
    // 只涵蓋 VPS + SPS 開頭區段，不含後方 VCL slice
    expect(patched.prefixLength).toBe(4 + vps.length + 4 + sps.length);

    const reinspected = inspectSampleParameterSets(patched.patchedPrefix, 4);
    expect(reinspected.spsList[0]?.generalProfileIdc).toBe(HEVC_PROFILE_MAIN);
  });

  it("marks truncated in-band SPS as insufficient evidence and refuses partial patching", () => {
    const sps1 = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      compatB1: 0x20,
    });
    const sps2 = buildSyntheticSps({
      profileIdc: HEVC_PROFILE_MAIN_10,
      bitDepthLumaMinus8: 2,
      bitDepthChromaMinus8: 2,
    });
    // 構造樣本：完整 sps1 後接只剩 6 bytes（宣告長度為 sps2.length）的截斷 sps2
    const buf = new Uint8Array(4 + sps1.length + 4 + 6);
    const view = new DataView(buf.buffer);
    view.setUint32(0, sps1.length, false);
    buf.set(sps1, 4);
    const secondOffset = 4 + sps1.length;
    view.setUint32(secondOffset, sps2.length, false);
    buf.set(sps2.subarray(0, 6), secondOffset + 4);

    const inspected = inspectSampleParameterSets(buf, 4);
    expect(inspected.hasInBandParameterSets).toBe(true);
    expect(inspected.hasUnparsedSps).toBe(true);

    const hvcc = parseHvcc(
      buildSyntheticHvcc({ profileIdc: HEVC_PROFILE_MAIN_10, sps: sps1 }),
    )!;
    const classified = classifyHevcHeader(
      "mp4",
      hvcc,
      inspected.spsList,
      inspected.hasInBandParameterSets,
      null,
      inspected.hasUnparsedSps,
    );
    expect(classified.mismatchMain10On8Bit).toBe(false);
    expect(classified.unsafeReason).toBe("unparsed-sps");

    // 修補器必須拒絕只改前面 sps1 的半吊子結果
    const patched = patchSampleParameterSets(buf, 4);
    expect(patched).toEqual({
      ok: false,
      foundParameterSets: true,
      reason: "truncated-inband-parameter-set",
    });
  });
});
