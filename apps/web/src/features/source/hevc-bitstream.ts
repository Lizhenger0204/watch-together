/**
 * HEVC（H.265）位元流解析與安全邊界分類純函式（T-138，ADR 0006）。
 */

export const HEVC_NAL_VPS = 32;
export const HEVC_NAL_SPS = 33;
export const HEVC_PROFILE_MAIN = 1;
export const HEVC_PROFILE_MAIN_10 = 2;

export interface ParsedHevcSps {
  generalProfileSpace: number;
  generalTierFlag: number;
  generalProfileIdc: number;
  generalProfileCompatibilityFlags: number;
  generalLevelIdc: number;
  subLayerProfileIdcs: number[];
  chromaFormatIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
}

export interface HvccNaluRef {
  nalType: number;
  offset: number;
  length: number;
  bytes: Uint8Array;
}

export interface ParsedHvcc {
  generalProfileSpace: number;
  generalTierFlag: number;
  generalProfileIdc: number;
  generalProfileCompatibilityFlags: number;
  generalLevelIdc: number;
  chromaFormat: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  lengthSizeMinusOne: number;
  vpsList: HvccNaluRef[];
  spsList: HvccNaluRef[];
  parsedSpsList: ParsedHevcSps[];
}

export interface HevcProfileSummary {
  container: "mp4" | "mkv";
  declaredProfileIdc: number;
  declaredProfileName: string;
  bitDepthLuma: number;
  bitDepthChroma: number;
  mismatchMain10On8Bit: boolean;
  hasInBandParameterSets: boolean;
  unsafeReason: string | null;
}

/** 移除 HEVC EBSP 中的防偽零位元組（0x00 0x00 0x03 → 0x00 0x00）。 */
export function ebspToRbsp(ebsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < ebsp.length; i += 1) {
    const byte = ebsp[i]!;
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0x00 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** 將 RBSP 重新編碼為合法的 EBSP（遇到 0x00 0x00 [00..03] 時插入 0x03）。 */
export function rbspToEbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i += 1) {
    const byte = rbsp[i]!;
    if (zeros >= 2 && byte <= 0x03) {
      out.push(0x03);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0x00 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** 檢查 EBSP（2-byte NAL header 之後）是否含非法 start-code 或無效 EPB。 */
export function hasForbiddenStartCode(ebsp: Uint8Array): boolean {
  let zeros = 0;
  for (let i = 0; i < ebsp.length; i += 1) {
    const byte = ebsp[i]!;
    if (zeros >= 2) {
      if (byte <= 0x02) return true;
      if (byte === 0x03) {
        if (i + 1 >= ebsp.length || ebsp[i + 1]! > 0x03) return true;
        zeros = 0;
        continue;
      }
    }
    zeros = byte === 0x00 ? zeros + 1 : 0;
  }
  return false;
}

class BitReader {
  private bitPos = 0;

  constructor(private readonly data: Uint8Array) {}

  get bitsRemaining() {
    return this.data.length * 8 - this.bitPos;
  }

  readBits(count: number): number | null {
    if (count < 0 || count > 32 || this.bitsRemaining < count) return null;
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byteIndex = this.bitPos >> 3;
      const bitIndex = 7 - (this.bitPos & 7);
      value = value * 2 + ((this.data[byteIndex]! >> bitIndex) & 1);
      this.bitPos += 1;
    }
    return value;
  }

  skipBits(count: number): boolean {
    if (count < 0 || this.bitsRemaining < count) return false;
    this.bitPos += count;
    return true;
  }

  readUE(): number | null {
    let leadingZeros = 0;
    while (true) {
      const bit = this.readBits(1);
      if (bit === null) return null;
      if (bit === 1) break;
      leadingZeros += 1;
      if (leadingZeros > 31) return null;
    }
    if (leadingZeros === 0) return 0;
    const suffix = this.readBits(leadingZeros);
    if (suffix === null) return null;
    return (1 << leadingZeros) - 1 + suffix;
  }
}

function parseProfileTierLevel(reader: BitReader, maxSubLayersMinus1: number) {
  const generalProfileSpace = reader.readBits(2);
  const generalTierFlag = reader.readBits(1);
  const generalProfileIdc = reader.readBits(5);
  const generalProfileCompatibilityFlags = reader.readBits(32);
  if (
    generalProfileSpace === null ||
    generalTierFlag === null ||
    generalProfileIdc === null ||
    generalProfileCompatibilityFlags === null
  ) {
    return null;
  }
  if (!reader.skipBits(48)) return null;
  const generalLevelIdc = reader.readBits(8);
  if (generalLevelIdc === null) return null;

  const subLayerProfilePresent: boolean[] = [];
  const subLayerLevelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    const p = reader.readBits(1);
    const l = reader.readBits(1);
    if (p === null || l === null) return null;
    subLayerProfilePresent.push(p === 1);
    subLayerLevelPresent.push(l === 1);
  }
  if (
    maxSubLayersMinus1 > 0 &&
    !reader.skipBits((8 - maxSubLayersMinus1) * 2)
  ) {
    return null;
  }

  const subLayerProfileIdcs: number[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    if (subLayerProfilePresent[i]) {
      const subSpace = reader.readBits(2);
      const subTier = reader.readBits(1);
      const subIdc = reader.readBits(5);
      if (subSpace === null || subTier === null || subIdc === null) return null;
      subLayerProfileIdcs.push(subIdc);
      if (!reader.skipBits(80)) return null;
    }
    if (subLayerLevelPresent[i] && !reader.skipBits(8)) return null;
  }

  return {
    generalProfileSpace,
    generalTierFlag,
    generalProfileIdc,
    generalProfileCompatibilityFlags,
    generalLevelIdc,
    subLayerProfileIdcs,
  };
}

/** 解析 HEVC SPS（NAL unit type 33，含 2-byte NAL header），先驗證原始 EBSP 合法性。 */
export function parseHevcSps(nalu: Uint8Array): ParsedHevcSps | null {
  if (nalu.length < 18) return null;
  const nalType = (nalu[0]! >> 1) & 0x3f;
  if (nalType !== HEVC_NAL_SPS) return null;

  const ebsp = nalu.subarray(2);
  if (hasForbiddenStartCode(ebsp)) return null;

  const rbsp = ebspToRbsp(ebsp);
  const reader = new BitReader(rbsp);
  if (reader.readBits(4) === null) return null;
  const maxSubLayersMinus1 = reader.readBits(3);
  if (maxSubLayersMinus1 === null || maxSubLayersMinus1 > 6) return null;
  if (reader.readBits(1) === null) return null;

  const ptl = parseProfileTierLevel(reader, maxSubLayersMinus1);
  if (!ptl) return null;

  if (reader.readUE() === null) return null;
  const chromaFormatIdc = reader.readUE();
  if (chromaFormatIdc === null || chromaFormatIdc > 3) return null;
  if (chromaFormatIdc === 3 && reader.readBits(1) === null) return null;

  if (reader.readUE() === null || reader.readUE() === null) return null;
  const conformanceWindowFlag = reader.readBits(1);
  if (conformanceWindowFlag === null) return null;
  if (conformanceWindowFlag === 1) {
    for (let i = 0; i < 4; i += 1) {
      if (reader.readUE() === null) return null;
    }
  }

  const bitDepthLumaMinus8 = reader.readUE();
  const bitDepthChromaMinus8 = reader.readUE();
  if (bitDepthLumaMinus8 === null || bitDepthChromaMinus8 === null) return null;

  return {
    ...ptl,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
  };
}

/** 解析 HEVCDecoderConfigurationRecord（MP4 hvcC 與 MKV CodecPrivate 共用）。 */
export function parseHvcc(hvcc: Uint8Array): ParsedHvcc | null {
  if (hvcc.length < 23) return null;
  const view = new DataView(hvcc.buffer, hvcc.byteOffset, hvcc.byteLength);
  const byte1 = hvcc[1]!;
  const generalProfileSpace = (byte1 >> 6) & 0x03;
  const generalTierFlag = (byte1 >> 5) & 0x01;
  const generalProfileIdc = byte1 & 0x1f;
  const generalProfileCompatibilityFlags = view.getUint32(2, false);
  const generalLevelIdc = hvcc[12]!;
  const chromaFormat = hvcc[16]! & 0x03;
  const bitDepthLumaMinus8 = hvcc[17]! & 0x07;
  const bitDepthChromaMinus8 = hvcc[18]! & 0x07;
  const lengthSizeMinusOne = hvcc[21]! & 0x03;
  const numOfArrays = hvcc[22]!;

  const vpsList: HvccNaluRef[] = [];
  const spsList: HvccNaluRef[] = [];
  const parsedSpsList: ParsedHevcSps[] = [];

  let offset = 23;
  for (let i = 0; i < numOfArrays; i += 1) {
    if (offset + 3 > hvcc.length) return null;
    const declaredType = hvcc[offset]! & 0x3f;
    const numNalus = view.getUint16(offset + 1, false);
    offset += 3;
    for (let j = 0; j < numNalus; j += 1) {
      if (offset + 2 > hvcc.length) return null;
      const length = view.getUint16(offset, false);
      offset += 2;
      if (offset + length > hvcc.length || length < 2) return null;
      const bytes = hvcc.subarray(offset, offset + length);
      const nalType = (bytes[0]! >> 1) & 0x3f;
      if (nalType === HEVC_NAL_VPS || declaredType === HEVC_NAL_VPS) {
        vpsList.push({ nalType, offset, length, bytes });
      } else if (nalType === HEVC_NAL_SPS || declaredType === HEVC_NAL_SPS) {
        spsList.push({ nalType, offset, length, bytes });
        const parsed = parseHevcSps(bytes);
        if (parsed) parsedSpsList.push(parsed);
      }
      offset += length;
    }
  }

  return {
    generalProfileSpace,
    generalTierFlag,
    generalProfileIdc,
    generalProfileCompatibilityFlags,
    generalLevelIdc,
    chromaFormat,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    lengthSizeMinusOne,
    vpsList,
    spsList,
    parsedSpsList,
  };
}

export function profileIdcLabel(idc: number): string {
  if (idc === HEVC_PROFILE_MAIN) return "Main";
  if (idc === HEVC_PROFILE_MAIN_10) return "Main 10";
  if (idc === 3) return "Main Still Picture";
  if (idc === 4) return "Range Extensions";
  return `profile ${idc}`;
}

/**
 * 嚴格分類 HEVC 標頭：
 * 必須同時解析到至少一份 SPS、沒有任何無法解析的 SPS、且所有相關 SPS（含 hvcC 與 in-band）
 * 與容器標頭一致確認實際為 8-bit，才確診為 mismatchMain10On8Bit；
 * 缺 SPS、SPS 混有 10-bit 或解析失敗皆不確診為「實際 8-bit」。
 */
export function classifyHevcHeader(
  container: "mp4" | "mkv",
  hvcc: ParsedHvcc,
  extraSpsList: ParsedHevcSps[],
  hasInBandParameterSets: boolean,
  containerUnsafeReason: string | null = null,
  extraUnparsedSps = false,
): HevcProfileSummary {
  const allSps = [...hvcc.parsedSpsList, ...extraSpsList];
  const hasUnparsedSps =
    hvcc.spsList.length > hvcc.parsedSpsList.length || extraUnparsedSps;

  const bitDepthLuma =
    allSps.length > 0
      ? Math.max(...allSps.map((s) => s.bitDepthLumaMinus8)) + 8
      : hvcc.bitDepthLumaMinus8 + 8;
  const bitDepthChroma =
    allSps.length > 0
      ? Math.max(...allSps.map((s) => s.bitDepthChromaMinus8)) + 8
      : hvcc.bitDepthChromaMinus8 + 8;

  const declaredProfileName =
    hvcc.generalProfileSpace === 0
      ? profileIdcLabel(hvcc.generalProfileIdc)
      : `profile_space ${hvcc.generalProfileSpace} / ${profileIdcLabel(hvcc.generalProfileIdc)}`;

  const declaredMain10 =
    hvcc.generalProfileSpace === 0 &&
    hvcc.generalProfileIdc === HEVC_PROFILE_MAIN_10;
  const allSpsConfirmed8Bit =
    allSps.length > 0 &&
    !hasUnparsedSps &&
    hvcc.bitDepthLumaMinus8 === 0 &&
    hvcc.bitDepthChromaMinus8 === 0 &&
    allSps.every(
      (sps) => sps.bitDepthLumaMinus8 === 0 && sps.bitDepthChromaMinus8 === 0,
    );

  // 依規格將嚴格安全條件（profile_space、4:2:0 色度、SPS 一致性、sub-layer）直接納入確診，
  // 證據不足或非標準 4:2:0 Main 10 時不可標為 mismatchMain10On8Bit，保留原始播放錯誤。
  let bitstreamUnsafeReason: string | null = null;
  if (hvcc.generalProfileIdc === HEVC_PROFILE_MAIN_10) {
    if (hvcc.generalProfileSpace !== 0) {
      bitstreamUnsafeReason = "non-zero-profile-space";
    } else if (allSps.length === 0) {
      bitstreamUnsafeReason = "missing-sps";
    } else if (hasUnparsedSps) {
      bitstreamUnsafeReason = "unparsed-sps";
    } else if (allSpsConfirmed8Bit) {
      if (hvcc.chromaFormat !== 1) {
        bitstreamUnsafeReason = "non-420-chroma";
      } else {
        for (const sps of allSps) {
          if (sps.generalProfileSpace !== 0) {
            bitstreamUnsafeReason = "sps-non-zero-profile-space";
            break;
          }
          if (sps.generalProfileIdc !== HEVC_PROFILE_MAIN_10) {
            bitstreamUnsafeReason = "sps-profile-inconsistent";
            break;
          }
          if (sps.chromaFormatIdc !== 1) {
            bitstreamUnsafeReason = "sps-non-420-chroma";
            break;
          }
          if (sps.subLayerProfileIdcs.includes(HEVC_PROFILE_MAIN_10)) {
            bitstreamUnsafeReason = "sub-layer-main10";
            break;
          }
        }
      }
    }
  }

  const mismatchMain10On8Bit =
    declaredMain10 && allSpsConfirmed8Bit && bitstreamUnsafeReason === null;
  const unsafeReason = containerUnsafeReason ?? bitstreamUnsafeReason;

  return {
    container,
    declaredProfileIdc: hvcc.generalProfileIdc,
    declaredProfileName,
    bitDepthLuma,
    bitDepthChroma,
    mismatchMain10On8Bit,
    hasInBandParameterSets,
    unsafeReason,
  };
}

export function readNalLength(
  buf: Uint8Array,
  offset: number,
  lengthSize: number,
): number {
  let len = 0;
  for (let i = 0; i < lengthSize; i += 1) {
    len = len * 256 + buf[offset + i]!;
  }
  return len;
}

/** 檢查 length-prefixed 視訊封包開頭是否帶有 in-band VPS／SPS，並解析 SPS。 */
export function inspectSampleParameterSets(
  sample: Uint8Array,
  nalLengthSize: number,
): {
  hasInBandParameterSets: boolean;
  spsList: ParsedHevcSps[];
  hasUnparsedSps: boolean;
} {
  if (nalLengthSize < 1 || nalLengthSize > 4) {
    return {
      hasInBandParameterSets: false,
      spsList: [],
      hasUnparsedSps: false,
    };
  }
  let offset = 0;
  let hasInBandParameterSets = false;
  let hasUnparsedSps = false;
  let reachedVcl = false;
  const spsList: ParsedHevcSps[] = [];

  while (offset + nalLengthSize + 2 <= sample.length) {
    const nalLen = readNalLength(sample, offset, nalLengthSize);
    const dataStart = offset + nalLengthSize;
    if (nalLen < 2) {
      if (offset > 0) hasUnparsedSps = true;
      break;
    }
    const nalType = (sample[dataStart]! >> 1) & 0x3f;
    if (nalType < 32) {
      reachedVcl = true;
      break;
    }
    // 視窗已讀到非 VCL 標頭但宣告長度超出視窗：列為證據不足，不可當成沒有參數集。
    if (dataStart + nalLen > sample.length) {
      if (nalType === HEVC_NAL_VPS || nalType === HEVC_NAL_SPS) {
        hasInBandParameterSets = true;
      }
      hasUnparsedSps = true;
      break;
    }
    if (nalType === HEVC_NAL_VPS) {
      hasInBandParameterSets = true;
    } else if (nalType === HEVC_NAL_SPS) {
      hasInBandParameterSets = true;
      const parsed = parseHevcSps(
        sample.subarray(dataStart, dataStart + nalLen),
      );
      if (parsed) {
        spsList.push(parsed);
      } else {
        hasUnparsedSps = true;
      }
    }
    offset = dataStart + nalLen;
  }

  if (offset > 0 && !reachedVcl && offset < sample.length) {
    hasUnparsedSps = true;
  }

  return { hasInBandParameterSets, spsList, hasUnparsedSps };
}
