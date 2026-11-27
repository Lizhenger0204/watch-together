/**
 * HEVC VPS／SPS／hvcC 位元流免重編碼 profile 修補與零複製 Blob 拼接（T-138，ADR 0006）。
 */

import {
  ebspToRbsp,
  hasForbiddenStartCode,
  HEVC_NAL_SPS,
  HEVC_NAL_VPS,
  HEVC_PROFILE_MAIN,
  HEVC_PROFILE_MAIN_10,
  parseHevcSps,
  parseHevcVpsPtl,
  rbspToEbsp,
  readNalLength,
} from "./hevc-bitstream";

export interface BytePatch {
  offset: number;
  length: number;
  bytes: Uint8Array;
}

export type ZeroCopyFixResult =
  | { ok: true; blob: Blob; patchedRanges: number }
  | { ok: false; reason: string };

export type NaluPatchResult =
  | { ok: true; patched: Uint8Array; sameLength: boolean; changed: boolean }
  | { ok: false; reason: string };

export type HvccPatchResult =
  | { ok: true; patched: Uint8Array; sameLength: boolean; patchedNalus: number }
  | { ok: false; reason: string };

export type SamplePatchResult =
  | {
      ok: true;
      foundParameterSets: boolean;
      /** 實際涵蓋開頭參數集區段的原位元組長度（絕不回寫後方 VCL 或相鄰樣本）。 */
      prefixLength: number;
      patchedPrefix: Uint8Array;
      sameLength: boolean;
      changed: boolean;
    }
  | { ok: false; foundParameterSets: true; reason: string };

export async function sliceBlobBytes(
  file: Blob,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (offset < 0 || offset >= file.size || length <= 0) {
    return new Uint8Array(0);
  }
  const end = Math.min(file.size, offset + length);
  return new Uint8Array(await file.slice(offset, end).arrayBuffer());
}

/** 依非重疊 BytePatch 列表建立零複製拼接 Blob，拒絕任何越界或重疊區段。 */
export function spliceZeroCopyBlob(
  file: Blob,
  patches: BytePatch[],
  mimeType: string,
): Blob {
  const sorted = [...patches].sort((a, b) => a.offset - b.offset);
  const parts: BlobPart[] = [];
  let cursor = 0;
  for (const patch of sorted) {
    if (
      patch.offset < 0 ||
      patch.length < 0 ||
      patch.offset + patch.length > file.size
    ) {
      throw new RangeError("patch-out-of-bounds");
    }
    if (patch.offset < cursor) {
      throw new RangeError("patch-overlap");
    }
    if (patch.offset > cursor) {
      parts.push(file.slice(cursor, patch.offset));
    }
    parts.push(new Uint8Array(patch.bytes));
    cursor = patch.offset + patch.length;
  }
  if (cursor < file.size) {
    parts.push(file.slice(cursor, file.size));
  }
  return new Blob(parts, { type: mimeType });
}

export function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * 將 VPS（32）或 SPS（33）NALU 中的 general_profile_idc 從 Main 10（2）改為 Main（1），
 * 並開啟 Main 相容旗標（bit 1，即 b1 | 0x40），全程驗證原始與輸出 EBSP 合法性並做往返斷言。
 */
export function patchHevcParameterSetNalu(nalu: Uint8Array): NaluPatchResult {
  if (nalu.length < 2) return { ok: false, reason: "nalu-too-short" };
  const nalType = (nalu[0]! >> 1) & 0x3f;
  if (nalType !== HEVC_NAL_VPS && nalType !== HEVC_NAL_SPS) {
    return { ok: true, patched: nalu, sameLength: true, changed: false };
  }
  if (nalu.length < 18) return { ok: false, reason: "nalu-too-short" };

  // 先驗證原始 EBSP 不含非法 start-code 或無效 EPB（例如 00 00 03 04），不可默默吃掉非法輸入。
  const origEbsp = nalu.subarray(2);
  if (hasForbiddenStartCode(origEbsp)) {
    return { ok: false, reason: "input-epb-invalid" };
  }

  // 每份待檢查／改寫的 VPS／SPS 皆須在寫入前套用與分類相同的嚴格安全條件，防止後段新增參數集繞過。
  if (nalType === HEVC_NAL_SPS) {
    const origSps = parseHevcSps(nalu);
    if (!origSps) return { ok: false, reason: "sps-unparseable" };
    if (origSps.generalProfileSpace !== 0) {
      return { ok: false, reason: "sps-non-zero-profile-space" };
    }
    if (origSps.chromaFormatIdc !== 1) {
      return { ok: false, reason: "sps-non-420-chroma" };
    }
    if (
      origSps.bitDepthLumaMinus8 !== 0 ||
      origSps.bitDepthChromaMinus8 !== 0
    ) {
      return { ok: false, reason: "sps-non-8bit" };
    }
    if (origSps.subLayerProfileIdcs.includes(HEVC_PROFILE_MAIN_10)) {
      return { ok: false, reason: "sub-layer-main10" };
    }
  } else {
    const origVps = parseHevcVpsPtl(nalu);
    if (!origVps) return { ok: false, reason: "vps-unparseable" };
    if (origVps.generalProfileSpace !== 0) {
      return { ok: false, reason: "non-zero-profile-space" };
    }
    if (origVps.subLayerProfileIdcs.includes(HEVC_PROFILE_MAIN_10)) {
      return { ok: false, reason: "sub-layer-main10" };
    }
  }

  const ptlOffset = nalType === HEVC_NAL_VPS ? 4 : 1;
  const origRbsp = ebspToRbsp(origEbsp);
  if (origRbsp.length < ptlOffset + 12) {
    return { ok: false, reason: "rbsp-too-short" };
  }

  const oldB0 = origRbsp[ptlOffset]!;
  const oldB1 = origRbsp[ptlOffset + 1]!;
  if (oldB0 >> 6 !== 0) {
    return { ok: false, reason: "non-zero-profile-space" };
  }
  const oldProfile = oldB0 & 0x1f;
  if (oldProfile !== HEVC_PROFILE_MAIN_10) {
    if (oldProfile === HEVC_PROFILE_MAIN) {
      return { ok: true, patched: nalu, sameLength: true, changed: false };
    }
    return { ok: false, reason: `unexpected-profile-${oldProfile}` };
  }

  const targetRbsp = new Uint8Array(origRbsp);
  targetRbsp[ptlOffset] = (oldB0 & 0xe0) | HEVC_PROFILE_MAIN;
  targetRbsp[ptlOffset + 1] = oldB1 | 0x40;

  const patchedEbsp = rbspToEbsp(targetRbsp);
  if (hasForbiddenStartCode(patchedEbsp)) {
    return { ok: false, reason: "epb-forbidden-sequence" };
  }

  // 嚴格 EBSP↔RBSP 往返斷言：只能改變目標的 1–2 個 RBSP 位元組。
  const roundTripRbsp = ebspToRbsp(patchedEbsp);
  if (roundTripRbsp.length !== origRbsp.length) {
    return { ok: false, reason: "epb-roundtrip-length-mismatch" };
  }
  for (let i = 0; i < roundTripRbsp.length; i += 1) {
    if (roundTripRbsp[i] !== targetRbsp[i]) {
      return { ok: false, reason: "epb-roundtrip-byte-mismatch" };
    }
    if (
      i !== ptlOffset &&
      i !== ptlOffset + 1 &&
      roundTripRbsp[i] !== origRbsp[i]
    ) {
      return { ok: false, reason: "epb-unexpected-mutation" };
    }
  }

  const patched = new Uint8Array(2 + patchedEbsp.length);
  patched[0] = nalu[0]!;
  patched[1] = nalu[1]!;
  patched.set(patchedEbsp, 2);

  if (nalType === HEVC_NAL_SPS) {
    const verified = parseHevcSps(patched);
    if (
      !verified ||
      verified.generalProfileSpace !== 0 ||
      verified.generalProfileIdc !== HEVC_PROFILE_MAIN ||
      verified.bitDepthLumaMinus8 !== 0 ||
      verified.bitDepthChromaMinus8 !== 0 ||
      verified.chromaFormatIdc !== 1 ||
      verified.subLayerProfileIdcs.includes(HEVC_PROFILE_MAIN_10)
    ) {
      return { ok: false, reason: "sps-reparse-failed" };
    }
  }

  return {
    ok: true,
    patched,
    sameLength: patched.length === nalu.length,
    changed: true,
  };
}

/** 修補整個 HEVCDecoderConfigurationRecord（hvcC／MKV CodecPrivate）。 */
export function patchHvccRecord(hvcc: Uint8Array): HvccPatchResult {
  if (hvcc.length < 23) return { ok: false, reason: "hvcc-too-short" };
  const oldB1 = hvcc[1]!;
  if (oldB1 >> 6 !== 0 || (oldB1 & 0x1f) !== HEVC_PROFILE_MAIN_10) {
    return { ok: false, reason: "hvcc-not-main10" };
  }

  const header = new Uint8Array(hvcc.subarray(0, 23));
  header[1] = (oldB1 & 0xe0) | HEVC_PROFILE_MAIN;
  header[2] = hvcc[2]! | 0x40;

  const view = new DataView(hvcc.buffer, hvcc.byteOffset, hvcc.byteLength);
  const numArrays = header[22]!;
  const chunks: Uint8Array[] = [header];
  let offset = 23;
  let patchedNalus = 0;

  for (let i = 0; i < numArrays; i += 1) {
    if (offset + 3 > hvcc.length)
      return { ok: false, reason: "hvcc-truncated" };
    const arrayHeader = hvcc[offset]!;
    const numNalus = view.getUint16(offset + 1, false);
    offset += 3;
    chunks.push(
      new Uint8Array([arrayHeader, (numNalus >> 8) & 0xff, numNalus & 0xff]),
    );
    for (let j = 0; j < numNalus; j += 1) {
      if (offset + 2 > hvcc.length) {
        return { ok: false, reason: "hvcc-truncated" };
      }
      const naluLen = view.getUint16(offset, false);
      offset += 2;
      if (offset + naluLen > hvcc.length || naluLen < 2) {
        return { ok: false, reason: "hvcc-nalu-out-of-bounds" };
      }
      const nalu = hvcc.subarray(offset, offset + naluLen);
      offset += naluLen;
      const result = patchHevcParameterSetNalu(nalu);
      if (!result.ok) return result;
      if (result.changed) patchedNalus += 1;
      if (result.patched.length > 0xffff) {
        return { ok: false, reason: "nalu-length-overflow" };
      }
      chunks.push(
        new Uint8Array([
          (result.patched.length >> 8) & 0xff,
          result.patched.length & 0xff,
        ]),
        result.patched,
      );
    }
  }
  if (offset < hvcc.length) chunks.push(hvcc.subarray(offset));

  const patched = concatUint8Arrays(chunks);
  return {
    ok: true,
    patched,
    sameLength: patched.length === hvcc.length,
    patchedNalus,
  };
}

function writeNalLength(
  buf: Uint8Array,
  offset: number,
  lengthSize: number,
  value: number,
) {
  let remaining = value;
  for (let i = lengthSize - 1; i >= 0; i -= 1) {
    buf[offset + i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
}

/**
 * 修補 length-prefixed 視訊封包開頭的 in-band VPS／SPS，
 * 只回傳被涵蓋的開頭參數集區段（prefixLength），絕不回寫後方 VCL 或相鄰樣本。
 */
export function patchSampleParameterSets(
  sample: Uint8Array,
  nalLengthSize: number,
): SamplePatchResult {
  if (nalLengthSize < 1 || nalLengthSize > 4) {
    return {
      ok: true,
      foundParameterSets: false,
      prefixLength: 0,
      patchedPrefix: new Uint8Array(0),
      sameLength: true,
      changed: false,
    };
  }
  let offset = 0;
  let foundParameterSets = false;
  let changed = false;
  let reachedVcl = false;
  const pieces: Uint8Array[] = [];

  while (offset + nalLengthSize + 2 <= sample.length) {
    const nalLen = readNalLength(sample, offset, nalLengthSize);
    const dataStart = offset + nalLengthSize;
    if (nalLen < 2) {
      if (foundParameterSets || offset > 0) {
        return {
          ok: false,
          foundParameterSets: true,
          reason: "invalid-inband-nalu-length",
        };
      }
      break;
    }
    const nalType = (sample[dataStart]! >> 1) & 0x3f;
    if (nalType < 32) {
      reachedVcl = true;
      break;
    }
    if (dataStart + nalLen > sample.length) {
      return {
        ok: false,
        foundParameterSets: true,
        reason: "truncated-inband-parameter-set",
      };
    }

    const nalu = sample.subarray(dataStart, dataStart + nalLen);
    if (nalType === HEVC_NAL_VPS || nalType === HEVC_NAL_SPS) {
      foundParameterSets = true;
      const res = patchHevcParameterSetNalu(nalu);
      if (!res.ok) {
        return { ok: false, foundParameterSets: true, reason: res.reason };
      }
      if (res.changed) changed = true;
      const lenBytes = new Uint8Array(nalLengthSize);
      writeNalLength(lenBytes, 0, nalLengthSize, res.patched.length);
      pieces.push(lenBytes, res.patched);
    } else {
      pieces.push(sample.subarray(offset, dataStart + nalLen));
    }
    offset = dataStart + nalLen;
  }

  if (offset > 0 && !reachedVcl && offset < sample.length) {
    return {
      ok: false,
      foundParameterSets: true,
      reason: "truncated-inband-parameter-set",
    };
  }

  if (!changed) {
    return {
      ok: true,
      foundParameterSets,
      prefixLength: offset,
      patchedPrefix: sample.subarray(0, offset),
      sameLength: true,
      changed: false,
    };
  }

  const patchedPrefix = concatUint8Arrays(pieces);
  return {
    ok: true,
    foundParameterSets,
    prefixLength: offset,
    patchedPrefix,
    sameLength: patchedPrefix.length === offset,
    changed: true,
  };
}
