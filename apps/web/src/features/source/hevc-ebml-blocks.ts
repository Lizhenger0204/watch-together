/**
 * Matroska Cluster／BlockGroup 掃描與探測視窗邊界驗證（T-138，ADR 0006）。
 */

import {
  EBML_ID_BLOCK,
  EBML_ID_BLOCK_GROUP,
  EBML_ID_CLUSTER,
  EBML_ID_CRC32,
  EBML_ID_SIMPLE_BLOCK,
  SEGMENT_LEVEL_IDS,
  iterateEbmlChildrenStrict,
  readEbmlId,
  readEbmlVint,
} from "./hevc-ebml";

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

/** 區分標頭確實被讀取視窗切斷，與無效首 byte 或標頭／最小長度已超出父容器宣告邊界。 */
function isEbmlHeaderCutByWindow(
  buf: Uint8Array,
  pos: number,
  maxLen: number,
  declaredEnd?: number,
  minTrailingBytes = 0,
  checkMinSize = false,
): boolean {
  if (pos >= buf.length) {
    return (
      declaredEnd === undefined ||
      pos + Math.max(1, minTrailingBytes) <= declaredEnd
    );
  }
  const first = buf[pos]!;
  if (first === 0) return false;
  let len = 1;
  let mask = 0x80;
  while ((first & mask) === 0 && len <= maxLen) {
    mask >>= 1;
    len += 1;
  }
  if (len > maxLen) return false;
  if (declaredEnd !== undefined && pos + len + minTrailingBytes > declaredEnd) {
    return false;
  }
  if (pos + len <= buf.length) return false;
  if (checkMinSize && declaredEnd !== undefined) {
    const maxPayload = declaredEnd - (pos + len);
    let minVal = first & (mask - 1);
    for (let i = pos + 1; i < buf.length; i += 1) {
      minVal = minVal * 256 + buf[i]!;
      if (minVal > maxPayload) return false;
    }
    for (let i = 0; i < pos + len - buf.length; i += 1) {
      minVal *= 256;
      if (minVal > maxPayload) return false;
    }
  }
  return true;
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
      return groupTruncated &&
        isEbmlHeaderCutByWindow(buf, pos, 4, declaredGroupEnd, 1)
        ? { corrupt: false, block }
        : { corrupt: true, block: null };
    }
    const subSize = readEbmlVint(buf, pos + subId.length);
    if (!subSize) {
      return groupTruncated &&
        isEbmlHeaderCutByWindow(
          buf,
          pos + subId.length,
          8,
          declaredGroupEnd,
          0,
          true,
        )
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
  if (!sizeInfo || sizeInfo.unknown) return null;
  const start = idInfo.length + sizeInfo.length;
  // 若已知所屬 Cluster 或檔案剩餘空間，block 宣告長度絕不可越界
  if (
    maxElementBytes !== undefined &&
    start + sizeInfo.value > maxElementBytes
  ) {
    return null;
  }
  const truncated = start + sizeInfo.value > buf.length;
  const end = Math.min(buf.length, start + sizeInfo.value);

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
  fileSize?: number,
): MkvBlockPayload[] {
  const idInfo = readEbmlId(clusterBuf, 0);
  if (!idInfo || idInfo.id !== EBML_ID_CLUSTER) return [];
  const sizeInfo = readEbmlVint(clusterBuf, idInfo.length);
  if (!sizeInfo) return [];
  const start = idInfo.length + sizeInfo.length;
  const remainingInFile =
    fileSize !== undefined
      ? Math.max(0, fileSize - clusterFileOffset)
      : undefined;
  const declaredClusterEnd = sizeInfo.unknown
    ? undefined
    : start + sizeInfo.value;
  if (
    declaredClusterEnd !== undefined &&
    remainingInFile !== undefined &&
    declaredClusterEnd > remainingInFile
  ) {
    return [];
  }
  const maxChildEnd = declaredClusterEnd ?? remainingInFile;
  const end =
    declaredClusterEnd !== undefined
      ? Math.min(clusterBuf.length, declaredClusterEnd)
      : clusterBuf.length;

  const results: MkvBlockPayload[] = [];
  const reachedEof =
    remainingInFile !== undefined && clusterBuf.length >= remainingInFile;
  const clusterTruncated = sizeInfo.unknown
    ? !reachedEof
    : declaredClusterEnd! > clusterBuf.length;
  let pos = start;
  // 持續驗證已讀視窗內全部子元素邊界，避免收滿 maxBlocks 後漏掉後方越界或損毀元素
  while (pos < end) {
    const cid = readEbmlId(clusterBuf, pos);
    if (!cid) {
      return clusterTruncated &&
        isEbmlHeaderCutByWindow(clusterBuf, pos, 4, maxChildEnd, 1)
        ? results
        : [];
    }
    if (sizeInfo.unknown && SEGMENT_LEVEL_IDS.has(cid.id)) break;
    const csize = readEbmlVint(clusterBuf, pos + cid.length);
    if (!csize) {
      return clusterTruncated &&
        isEbmlHeaderCutByWindow(
          clusterBuf,
          pos + cid.length,
          8,
          maxChildEnd,
          0,
          true,
        )
        ? results
        : [];
    }
    if (csize.unknown) return [];
    const dataStart = pos + cid.length + csize.length;
    if (maxChildEnd !== undefined && dataStart + csize.value > maxChildEnd) {
      return [];
    }
    const blockTruncated = dataStart + csize.value > end;
    const dataEnd = Math.min(end, dataStart + csize.value);

    if (cid.id === EBML_ID_SIMPLE_BLOCK) {
      if (results.length < maxBlocks) {
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
      }
    } else if (cid.id === EBML_ID_BLOCK_GROUP) {
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
      if (results.length < maxBlocks && parsed.block) {
        results.push(parsed.block);
      }
    }
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
