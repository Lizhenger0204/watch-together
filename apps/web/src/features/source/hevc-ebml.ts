/**
 * Matroska／EBML 低階 VINT、子元素、SeekHead、Cues、Cluster 走訪與 CRC-32 工具（T-138，ADR 0006）。
 */

import { sliceBlobBytes } from "./hevc-patch";
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

export interface MkvBlockPayload {
  fileOffset: number;
  bytes: Uint8Array;
  laced: boolean;
  truncated?: boolean;
  blockGroup?: {
    payloadOffset: number;
    payload: Uint8Array;
  } | null;
}

export interface MkvScannedCluster {
  payloadFileOffset: number;
  payload: Uint8Array;
  unknownSize: boolean;
  hasCrc32: boolean;
  blocks: MkvBlockPayload[];
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

function decodeMkvBlockPayload(
  buf: Uint8Array,
  dataStart: number,
  dataEnd: number,
  baseFileOffset: number,
  targetTrack: number,
  blockGroup: { payloadOffset: number; payload: Uint8Array } | null = null,
  truncated = false,
): MkvBlockPayload | null {
  const trackVint = readEbmlVint(buf, dataStart);
  if (!trackVint || trackVint.value !== targetTrack) return null;
  const headerLen = trackVint.length + 3;
  if (dataStart + headerLen >= dataEnd) return null;
  const flags = buf[dataStart + trackVint.length + 2]!;
  return {
    fileOffset: baseFileOffset + dataStart + headerLen,
    bytes: buf.subarray(dataStart + headerLen, dataEnd),
    laced: ((flags >> 1) & 0x03) !== 0,
    truncated,
    blockGroup,
  };
}

function parseBlockGroupElement(
  buf: Uint8Array,
  groupStart: number,
  groupEnd: number,
  declaredGroupEnd: number | undefined,
  groupTruncated: boolean,
  baseFileOffset: number,
  targetTrack: number,
): { corrupt: boolean; block: MkvBlockPayload | null } {
  let block: MkvBlockPayload | null = null;
  let pos = groupStart;
  while (pos < groupEnd) {
    const subId = readEbmlId(buf, pos);
    if (!subId) {
      return groupTruncated
        ? { corrupt: false, block }
        : { corrupt: true, block: null };
    }
    const subSize = readEbmlVint(buf, pos + subId.length);
    if (!subSize) {
      return groupTruncated
        ? { corrupt: false, block }
        : { corrupt: true, block: null };
    }
    if (subSize.unknown) return { corrupt: true, block: null };
    const subStart = pos + subId.length + subSize.length;
    const subDeclaredEnd = subStart + subSize.value;
    if (declaredGroupEnd !== undefined && subDeclaredEnd > declaredGroupEnd) {
      return { corrupt: true, block: null };
    }
    if (!groupTruncated && subDeclaredEnd > groupEnd) {
      return { corrupt: true, block: null };
    }
    const subEnd = Math.min(groupEnd, subDeclaredEnd);
    if (subId.id === EBML_ID_BLOCK && block === null) {
      block = decodeMkvBlockPayload(
        buf,
        subStart,
        subEnd,
        baseFileOffset,
        targetTrack,
        null,
        subDeclaredEnd > groupEnd,
      );
    }
    if (subDeclaredEnd > groupEnd) break;
    pos = subDeclaredEnd;
  }
  return { corrupt: false, block };
}

export function parseSingleBlockElement(
  buf: Uint8Array,
  elementFileOffset: number,
  targetTrack: number,
  maxElementBytes?: number,
): MkvBlockPayload | null {
  const idInfo = readEbmlId(buf, 0);
  if (!idInfo) return null;
  const sizeInfo = readEbmlVint(buf, idInfo.length);
  if (!sizeInfo) return null;
  const start = idInfo.length + sizeInfo.length;
  // 若已知所屬 Cluster 剩餘空間，block 宣告長度絕不可越出 Cluster 邊界
  if (
    maxElementBytes !== undefined &&
    !sizeInfo.unknown &&
    start + sizeInfo.value > maxElementBytes
  ) {
    return null;
  }
  const truncated = sizeInfo.unknown || start + sizeInfo.value > buf.length;
  const end = sizeInfo.unknown
    ? buf.length
    : Math.min(buf.length, start + sizeInfo.value);

  if (idInfo.id === EBML_ID_SIMPLE_BLOCK) {
    return decodeMkvBlockPayload(
      buf,
      start,
      end,
      elementFileOffset,
      targetTrack,
      null,
      truncated,
    );
  }
  if (idInfo.id === EBML_ID_BLOCK_GROUP) {
    if (sizeInfo.unknown) return null;
    const parsed = parseBlockGroupElement(
      buf,
      start,
      end,
      start + sizeInfo.value,
      truncated,
      elementFileOffset,
      targetTrack,
    );
    return parsed.corrupt ? null : parsed.block;
  }
  return null;
}

export function extractVideoBlocksFromCluster(
  clusterBuf: Uint8Array,
  clusterFileOffset: number,
  targetTrack: number,
  maxBlocks: number,
): MkvBlockPayload[] {
  const idInfo = readEbmlId(clusterBuf, 0);
  if (!idInfo || idInfo.id !== EBML_ID_CLUSTER) return [];
  const sizeInfo = readEbmlVint(clusterBuf, idInfo.length);
  if (!sizeInfo) return [];
  const start = idInfo.length + sizeInfo.length;
  const declaredClusterEnd = sizeInfo.unknown
    ? undefined
    : start + sizeInfo.value;
  const end = sizeInfo.unknown
    ? clusterBuf.length
    : Math.min(clusterBuf.length, start + sizeInfo.value);

  const results: MkvBlockPayload[] = [];
  let pos = start;
  while (pos < end && results.length < maxBlocks) {
    const cid = readEbmlId(clusterBuf, pos);
    if (!cid) break;
    if (sizeInfo.unknown && SEGMENT_LEVEL_IDS.has(cid.id)) break;
    const csize = readEbmlVint(clusterBuf, pos + cid.length);
    if (!csize) break;
    const dataStart = pos + cid.length + csize.length;
    const blockTruncated = csize.unknown || dataStart + csize.value > end;
    const dataEnd = csize.unknown
      ? end
      : Math.min(end, dataStart + csize.value);

    if (cid.id === EBML_ID_SIMPLE_BLOCK) {
      const payload = decodeMkvBlockPayload(
        clusterBuf,
        dataStart,
        dataEnd,
        clusterFileOffset,
        targetTrack,
        null,
        blockTruncated,
      );
      if (payload) results.push(payload);
    } else if (cid.id === EBML_ID_BLOCK_GROUP) {
      if (
        csize.unknown ||
        (declaredClusterEnd !== undefined &&
          dataStart + csize.value > declaredClusterEnd)
      ) {
        return [];
      }
      const parsed = parseBlockGroupElement(
        clusterBuf,
        dataStart,
        dataEnd,
        dataStart + csize.value,
        dataStart + csize.value > end,
        clusterFileOffset,
        targetTrack,
      );
      if (parsed.corrupt) return [];
      if (parsed.block) results.push(parsed.block);
    }
    if (csize.unknown) break;
    pos = dataEnd;
  }
  return results;
}

/**
 * 完整走訪小型 MKV 從第一個 Cluster 到檔尾的所有 Segment 元素與 Cluster（支援 RFC 8794 §6.2 未知長度 Cluster 終止）。
 * 任何截斷、無界未知長度子元素或 Segment 層級 CRC-32 一律明確回傳失敗以便降級。
 */
export function walkSmallMkvClusters(
  segTail: Uint8Array,
  baseFileOffset: number,
  targetTrack: number,
): { ok: true; clusters: MkvScannedCluster[] } | { ok: false; reason: string } {
  const clusters: MkvScannedCluster[] = [];
  let pos = 0;

  while (pos < segTail.length) {
    const idInfo = readEbmlId(segTail, pos);
    if (!idInfo) return { ok: false, reason: "mkv-corrupt-segment" };
    const sizeInfo = readEbmlVint(segTail, pos + idInfo.length);
    if (!sizeInfo) return { ok: false, reason: "mkv-corrupt-segment" };
    const dataStart = pos + idInfo.length + sizeInfo.length;

    if (idInfo.id === EBML_ID_CRC32) {
      return { ok: false, reason: "mkv-segment-crc32-unsupported" };
    }

    if (idInfo.id === EBML_ID_CLUSTER) {
      if (!sizeInfo.unknown && dataStart + sizeInfo.value > segTail.length) {
        return { ok: false, reason: "mkv-truncated-cluster" };
      }
      const limit = sizeInfo.unknown
        ? segTail.length
        : dataStart + sizeInfo.value;
      const blocks: MkvBlockPayload[] = [];
      let hasCrc32 = false;
      let cPos = dataStart;

      while (cPos < limit) {
        const childId = readEbmlId(segTail, cPos);
        if (!childId) return { ok: false, reason: "mkv-corrupt-cluster" };
        if (sizeInfo.unknown && SEGMENT_LEVEL_IDS.has(childId.id)) {
          break;
        }
        const childSize = readEbmlVint(segTail, cPos + childId.length);
        if (!childSize || childSize.unknown) {
          return { ok: false, reason: "mkv-unknown-size-cluster-child" };
        }
        const cDataStart = cPos + childId.length + childSize.length;
        const cDataEnd = cDataStart + childSize.value;
        if (cDataEnd > limit) {
          return { ok: false, reason: "mkv-truncated-cluster-child" };
        }

        if (childId.id === EBML_ID_CRC32) {
          hasCrc32 = true;
        } else if (childId.id === EBML_ID_SIMPLE_BLOCK) {
          const payload = decodeMkvBlockPayload(
            segTail,
            cDataStart,
            cDataEnd,
            baseFileOffset,
            targetTrack,
          );
          if (payload) blocks.push(payload);
        } else if (childId.id === EBML_ID_BLOCK_GROUP) {
          const groupChildren = iterateEbmlChildrenStrict(
            segTail,
            cDataStart,
            cDataEnd,
          );
          if (!groupChildren) {
            return { ok: false, reason: "mkv-corrupt-block-group" };
          }
          const groupInfo = {
            payloadOffset: baseFileOffset + cDataStart,
            payload: segTail.subarray(cDataStart, cDataEnd),
          };
          for (const sub of groupChildren) {
            if (sub.id !== EBML_ID_BLOCK) continue;
            const payload = decodeMkvBlockPayload(
              segTail,
              sub.dataStart,
              sub.dataEnd,
              baseFileOffset,
              targetTrack,
              groupInfo,
            );
            if (payload) blocks.push(payload);
            break;
          }
        }
        cPos = cDataEnd;
      }

      if (!sizeInfo.unknown && cPos !== limit) {
        return { ok: false, reason: "mkv-corrupt-cluster" };
      }

      clusters.push({
        payloadFileOffset: baseFileOffset + dataStart,
        payload: segTail.subarray(dataStart, cPos),
        unknownSize: sizeInfo.unknown,
        hasCrc32,
        blocks,
      });
      pos = cPos;
      continue;
    }

    if (sizeInfo.unknown) {
      return { ok: false, reason: "mkv-unknown-size-segment-element" };
    }
    const elEnd = dataStart + sizeInfo.value;
    if (elEnd > segTail.length) {
      return { ok: false, reason: "mkv-truncated-segment-element" };
    }
    pos = elEnd;
  }

  return { ok: true, clusters };
}
