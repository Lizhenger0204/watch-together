/**
 * Matroska／EBML 低階 VINT、子元素、SeekHead、Cues 工具與重匯出入口（T-138，ADR 0006）。
 */

import { sliceBlobBytes } from "./hevc-patch";
export {
  extractVideoBlocksFromCluster,
  parseSingleBlockElement,
  walkSmallMkvClusters,
  type MkvBlockPayload,
  type MkvScannedCluster,
} from "./hevc-ebml-blocks";
export { computeEbmlCrc32, computeEbmlCrc32Patch } from "./hevc-ebml-crc";

export const EBML_ID_HEADER = 0x1a45dfa3;
export const EBML_ID_SEGMENT = 0x18538067;
export const EBML_ID_SEEK_HEAD = 0x114d9b74;
export const EBML_ID_SEEK = 0x4dbb;
export const EBML_ID_SEEK_ID = 0x53ab;
export const EBML_ID_SEEK_POS = 0x53ac;
export const EBML_ID_INFO = 0x1549a966;
export const EBML_ID_TRACKS = 0x1654ae6b;
export const EBML_ID_TRACK_ENTRY = 0xae;
export const EBML_ID_TRACK_NUMBER = 0xd7;
export const EBML_ID_TRACK_TYPE = 0x83;
export const EBML_ID_CODEC_ID = 0x86;
export const EBML_ID_CODEC_PRIVATE = 0x63a2;
export const EBML_ID_CONTENT_ENCODINGS = 0x6d80;
export const EBML_ID_CHAPTERS = 0x1043a770;
export const EBML_ID_CUES = 0x1c53bb6b;
export const EBML_ID_CUE_POINT = 0xbb;
export const EBML_ID_CUE_TRACK_POS = 0xb7;
export const EBML_ID_CUE_TRACK = 0xf7;
export const EBML_ID_CUE_CLUSTER_POS = 0xf1;
export const EBML_ID_CUE_RELATIVE_POS = 0xf0;
export const EBML_ID_CLUSTER = 0x1f43b675;
export const EBML_ID_SIMPLE_BLOCK = 0xa3;
export const EBML_ID_BLOCK_GROUP = 0xa0;
export const EBML_ID_BLOCK = 0xa1;
export const EBML_ID_ATTACHMENTS = 0x1941a469;
export const EBML_ID_TAGS = 0x1254c367;
export const EBML_ID_CRC32 = 0xbf;

/** RFC 8794 §6.2：未知長度 Cluster 遇到下一個 Segment 層級或更高層級元素時終止。 */
export const SEGMENT_LEVEL_IDS = new Set([
  EBML_ID_HEADER,
  EBML_ID_SEGMENT,
  EBML_ID_SEEK_HEAD,
  EBML_ID_INFO,
  EBML_ID_TRACKS,
  EBML_ID_CHAPTERS,
  EBML_ID_CLUSTER,
  EBML_ID_CUES,
  EBML_ID_ATTACHMENTS,
  EBML_ID_TAGS,
]);

export interface EbmlChild {
  elementStart: number;
  id: number;
  dataStart: number;
  dataEnd: number;
}

export interface MkvCueTarget {
  clusterOffset: number;
  relativePosition: number | null;
}

export function readEbmlId(
  buf: Uint8Array,
  offset: number,
): { id: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset]!;
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0 && length <= 4) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + buf[offset + i]!;
  return { id, length };
}

export function readEbmlVint(
  buf: Uint8Array,
  offset: number,
): { value: number; length: number; unknown: boolean } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset]!;
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0 && length <= 8) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    const byte = buf[offset + i]!;
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  if (!allOnes && value > Number.MAX_SAFE_INTEGER) return null;
  return { value, length, unknown: allOnes };
}

export function readUintBE(
  buf: Uint8Array,
  start: number,
  end: number,
): number {
  let value = 0;
  for (let i = start; i < end; i += 1) value = value * 256 + buf[i]!;
  return value;
}

export function iterateEbmlChildren(
  buf: Uint8Array,
  start: number,
  end: number,
): EbmlChild[] {
  const out: EbmlChild[] = [];
  let pos = start;
  while (pos < end) {
    const elementStart = pos;
    const idInfo = readEbmlId(buf, pos);
    if (!idInfo) break;
    pos += idInfo.length;
    const sizeInfo = readEbmlVint(buf, pos);
    if (!sizeInfo) break;
    pos += sizeInfo.length;
    const dataEnd = sizeInfo.unknown
      ? end
      : Math.min(end, pos + sizeInfo.value);
    out.push({ elementStart, id: idInfo.id, dataStart: pos, dataEnd });
    if (sizeInfo.unknown) break;
    pos = dataEnd;
  }
  return out;
}

/**
 * 嚴格走訪定長容器內的全部直接子元素：拒絕任何未知長度子元素、宣告長度越界或尾端殘留位元組。
 */
export function iterateEbmlChildrenStrict(
  buf: Uint8Array,
  start: number,
  end: number,
): EbmlChild[] | null {
  const out: EbmlChild[] = [];
  let pos = start;
  while (pos < end) {
    const elementStart = pos;
    const idInfo = readEbmlId(buf, pos);
    if (!idInfo) return null;
    pos += idInfo.length;
    const sizeInfo = readEbmlVint(buf, pos);
    if (!sizeInfo || sizeInfo.unknown) return null;
    pos += sizeInfo.length;
    const dataEnd = pos + sizeInfo.value;
    if (dataEnd > end) return null;
    out.push({ elementStart, id: idInfo.id, dataStart: pos, dataEnd });
    pos = dataEnd;
  }
  return pos === end ? out : null;
}

export async function readEbmlElementPayload(
  file: Blob,
  offset: number,
  expectedId: number,
  maxBytes: number,
): Promise<{ payloadOffset: number; payload: Uint8Array } | null> {
  const hdr = await sliceBlobBytes(file, offset, 16);
  const idInfo = readEbmlId(hdr, 0);
  if (!idInfo || idInfo.id !== expectedId) return null;
  const sizeInfo = readEbmlVint(hdr, idInfo.length);
  if (!sizeInfo || sizeInfo.unknown || sizeInfo.value > maxBytes) return null;
  const payloadOffset = offset + idInfo.length + sizeInfo.length;
  const payload = await sliceBlobBytes(file, payloadOffset, sizeInfo.value);
  if (payload.length !== sizeInfo.value) return null;
  return { payloadOffset, payload };
}

export function parseSeekHead(buf: Uint8Array, segmentDataStart: number) {
  let tracksOffset: number | null = null;
  let cuesOffset: number | null = null;
  for (const child of iterateEbmlChildren(buf, 0, buf.length)) {
    if (child.id !== EBML_ID_SEEK) continue;
    let seekId = 0;
    let seekPos: number | null = null;
    for (const field of iterateEbmlChildren(
      buf,
      child.dataStart,
      child.dataEnd,
    )) {
      if (field.id === EBML_ID_SEEK_ID) {
        seekId = readUintBE(buf, field.dataStart, field.dataEnd);
      } else if (field.id === EBML_ID_SEEK_POS) {
        seekPos = readUintBE(buf, field.dataStart, field.dataEnd);
      }
    }
    if (seekPos === null) continue;
    if (seekId === EBML_ID_TRACKS && tracksOffset === null) {
      tracksOffset = segmentDataStart + seekPos;
    } else if (seekId === EBML_ID_CUES && cuesOffset === null) {
      cuesOffset = segmentDataStart + seekPos;
    }
  }
  return { tracksOffset, cuesOffset };
}

export function parseCuesForTrack(
  buf: Uint8Array,
  segmentDataStart: number,
  targetTrack: number,
): MkvCueTarget[] {
  const seen = new Set<string>();
  const targets: MkvCueTarget[] = [];
  for (const point of iterateEbmlChildren(buf, 0, buf.length)) {
    if (point.id !== EBML_ID_CUE_POINT) continue;
    for (const field of iterateEbmlChildren(
      buf,
      point.dataStart,
      point.dataEnd,
    )) {
      if (field.id !== EBML_ID_CUE_TRACK_POS) continue;
      let trackNum = -1;
      let clusterPos: number | null = null;
      let relativePosition: number | null = null;
      for (const posField of iterateEbmlChildren(
        buf,
        field.dataStart,
        field.dataEnd,
      )) {
        if (posField.id === EBML_ID_CUE_TRACK) {
          trackNum = readUintBE(buf, posField.dataStart, posField.dataEnd);
        } else if (posField.id === EBML_ID_CUE_CLUSTER_POS) {
          clusterPos = readUintBE(buf, posField.dataStart, posField.dataEnd);
        } else if (posField.id === EBML_ID_CUE_RELATIVE_POS) {
          relativePosition = readUintBE(
            buf,
            posField.dataStart,
            posField.dataEnd,
          );
        }
      }
      if (trackNum === targetTrack && clusterPos !== null) {
        const clusterOffset = segmentDataStart + clusterPos;
        const key = `${clusterOffset}:${relativePosition ?? "none"}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push({ clusterOffset, relativePosition });
        }
      }
    }
  }
  return targets;
}
