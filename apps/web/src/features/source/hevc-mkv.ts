/**
 * Matroska（MKV）容器的輕量 HEVC 檔頭偵測與零複製修補（T-138，ADR 0006）。
 * 支援 SeekHead 指向檔尾的 Tracks／Cues、排除 ContentEncodings 壓縮或加密軌道、
 * 完整走訪小型 MKV 全部 Cluster（含未知長度 Cluster）並同步更新受影響的 EBML CRC-32；
 * 大型 MKV 含 in-band 參數集、遇 lacing 或無法安全更新 CRC-32 時明確降級。
 */

import {
  classifyHevcHeader,
  inspectSampleParameterSets,
  parseHvcc,
  type HevcProfileSummary,
  type ParsedHevcSps,
  type ParsedHvcc,
} from "./hevc-bitstream";
import {
  EBML_ID_CLUSTER,
  EBML_ID_CODEC_ID,
  EBML_ID_CODEC_PRIVATE,
  EBML_ID_CONTENT_ENCODINGS,
  EBML_ID_CRC32,
  EBML_ID_CUES,
  EBML_ID_HEADER,
  EBML_ID_SEEK_HEAD,
  EBML_ID_SEGMENT,
  EBML_ID_TRACK_ENTRY,
  EBML_ID_TRACK_NUMBER,
  EBML_ID_TRACK_TYPE,
  EBML_ID_TRACKS,
  computeEbmlCrc32Patch,
  extractVideoBlocksFromCluster,
  iterateEbmlChildren,
  iterateEbmlChildrenStrict,
  parseCuesForTrack,
  parseSeekHead,
  parseSingleBlockElement,
  readEbmlElementPayload,
  readEbmlId,
  readEbmlVint,
  readUintBE,
  walkSmallMkvClusters,
  type MkvBlockPayload,
  type MkvCueTarget,
} from "./hevc-ebml";
import {
  patchHvccRecord,
  patchSampleParameterSets,
  sliceBlobBytes,
  spliceZeroCopyBlob,
  type BytePatch,
  type ZeroCopyFixResult,
} from "./hevc-patch";

export type { MkvCueTarget } from "./hevc-ebml";

const MAX_TRACKS_BYTES = 2 * 1024 * 1024;
const MAX_CUES_BYTES = 8 * 1024 * 1024;
const CLUSTER_PROBE_BYTES = 16 * 1024;
const BLOCK_PREFIX_READ_BYTES = 8 * 1024;
const SMALL_MKV_SCAN_LIMIT = 4 * 1024 * 1024;

export interface MkvHevcInspection {
  container: "mkv";
  info: HevcProfileSummary;
  hvcc: ParsedHvcc;
  codecPrivateBytes: Uint8Array;
  codecPrivateFileOffset: number;
  tracksPayload: Uint8Array;
  tracksPayloadOffset: number;
  trackEntryPayload: Uint8Array;
  trackEntryPayloadOffset: number;
  segmentHasCrc32: boolean;
  largeMkvProbeFailed: boolean;
  trackNumber: number;
  segmentDataStart: number;
  firstClusterOffset: number | null;
  cueTargets: MkvCueTarget[];
}

export async function inspectMkvHevc(
  file: Blob,
): Promise<MkvHevcInspection | null> {
  const head = await sliceBlobBytes(file, 0, 64);
  const ebmlId = readEbmlId(head, 0);
  if (!ebmlId || ebmlId.id !== EBML_ID_HEADER) return null;
  const ebmlSize = readEbmlVint(head, ebmlId.length);
  if (!ebmlSize || ebmlSize.unknown) return null;

  const segmentOffset = ebmlId.length + ebmlSize.length + ebmlSize.value;
  const segHdr = await sliceBlobBytes(file, segmentOffset, 16);
  const segId = readEbmlId(segHdr, 0);
  if (!segId || segId.id !== EBML_ID_SEGMENT) return null;
  const segSize = readEbmlVint(segHdr, segId.length);
  if (!segSize) return null;
  const segmentDataStart = segmentOffset + segId.length + segSize.length;

  let tracksOffset: number | null = null;
  let cuesOffset: number | null = null;
  let firstClusterOffset: number | null = null;
  let segmentHasCrc32 = false;

  let pos = segmentDataStart;
  for (let steps = 0; steps < 64 && pos + 4 <= file.size; steps += 1) {
    const hdr = await sliceBlobBytes(file, pos, 16);
    const idInfo = readEbmlId(hdr, 0);
    if (!idInfo) break;
    const sizeInfo = readEbmlVint(hdr, idInfo.length);
    if (!sizeInfo) break;
    const payloadOffset = pos + idInfo.length + sizeInfo.length;

    if (idInfo.id === EBML_ID_CRC32) {
      segmentHasCrc32 = true;
    } else if (
      idInfo.id === EBML_ID_SEEK_HEAD &&
      !sizeInfo.unknown &&
      sizeInfo.value <= 65536
    ) {
      const shBuf = await sliceBlobBytes(file, payloadOffset, sizeInfo.value);
      const parsed = parseSeekHead(shBuf, segmentDataStart);
      if (parsed.tracksOffset !== null && tracksOffset === null) {
        tracksOffset = parsed.tracksOffset;
      }
      if (parsed.cuesOffset !== null && cuesOffset === null) {
        cuesOffset = parsed.cuesOffset;
      }
    } else if (idInfo.id === EBML_ID_TRACKS && tracksOffset === null) {
      tracksOffset = pos;
    } else if (idInfo.id === EBML_ID_CUES && cuesOffset === null) {
      cuesOffset = pos;
    } else if (idInfo.id === EBML_ID_CLUSTER) {
      firstClusterOffset = pos;
      break;
    }

    if (sizeInfo.unknown) break;
    pos = payloadOffset + sizeInfo.value;
  }

  if (tracksOffset === null) return null;
  const tracksEl = await readEbmlElementPayload(
    file,
    tracksOffset,
    EBML_ID_TRACKS,
    MAX_TRACKS_BYTES,
  );
  if (!tracksEl) return null;

  let foundTrack: {
    trackNumber: number;
    codecPrivateBytes: Uint8Array;
    codecPrivateFileOffset: number;
    trackEntryPayload: Uint8Array;
    trackEntryPayloadOffset: number;
    hasContentEncoding: boolean;
  } | null = null;

  let tracksCorruptBounds = false;
  const strictTrackEntries = iterateEbmlChildrenStrict(
    tracksEl.payload,
    0,
    tracksEl.payload.length,
  );
  if (!strictTrackEntries) tracksCorruptBounds = true;
  const trackEntries =
    strictTrackEntries ??
    iterateEbmlChildren(tracksEl.payload, 0, tracksEl.payload.length);

  for (const entry of trackEntries) {
    if (entry.id !== EBML_ID_TRACK_ENTRY) continue;
    const strictEntryFields = iterateEbmlChildrenStrict(
      tracksEl.payload,
      entry.dataStart,
      entry.dataEnd,
    );
    const entryFields =
      strictEntryFields ??
      iterateEbmlChildren(tracksEl.payload, entry.dataStart, entry.dataEnd);
    let trackNumber = -1;
    let trackType = -1;
    let codecId = "";
    let codecPrivate: { offset: number; bytes: Uint8Array } | null = null;
    let hasContentEncoding = false;

    for (const field of entryFields) {
      if (field.id === EBML_ID_TRACK_NUMBER) {
        trackNumber = readUintBE(
          tracksEl.payload,
          field.dataStart,
          field.dataEnd,
        );
      } else if (field.id === EBML_ID_TRACK_TYPE) {
        trackType = readUintBE(
          tracksEl.payload,
          field.dataStart,
          field.dataEnd,
        );
      } else if (field.id === EBML_ID_CODEC_ID) {
        codecId = new TextDecoder().decode(
          tracksEl.payload.subarray(field.dataStart, field.dataEnd),
        );
      } else if (field.id === EBML_ID_CODEC_PRIVATE) {
        codecPrivate = {
          offset: tracksEl.payloadOffset + field.dataStart,
          bytes: new Uint8Array(
            tracksEl.payload.subarray(field.dataStart, field.dataEnd),
          ),
        };
      } else if (field.id === EBML_ID_CONTENT_ENCODINGS) {
        hasContentEncoding = true;
      }
    }

    if (
      trackType === 1 &&
      codecId === "V_MPEGH/ISO/HEVC" &&
      codecPrivate &&
      trackNumber >= 0
    ) {
      if (!strictEntryFields) tracksCorruptBounds = true;
      foundTrack = {
        trackNumber,
        codecPrivateBytes: codecPrivate.bytes,
        codecPrivateFileOffset: codecPrivate.offset,
        trackEntryPayload: new Uint8Array(
          tracksEl.payload.subarray(entry.dataStart, entry.dataEnd),
        ),
        trackEntryPayloadOffset: tracksEl.payloadOffset + entry.dataStart,
        hasContentEncoding,
      };
      break;
    }
  }

  if (!foundTrack) return null;
  const hvcc = parseHvcc(foundTrack.codecPrivateBytes);
  if (!hvcc) return null;

  let cueTargets: MkvCueTarget[] = [];
  if (cuesOffset !== null) {
    const cuesEl = await readEbmlElementPayload(
      file,
      cuesOffset,
      EBML_ID_CUES,
      MAX_CUES_BYTES,
    );
    if (cuesEl) {
      cueTargets = parseCuesForTrack(
        cuesEl.payload,
        segmentDataStart,
        foundTrack.trackNumber,
      );
    }
  }

  const probeBlocks: MkvBlockPayload[] = [];
  let probeTargetUnreadable = false;
  if (firstClusterOffset !== null) {
    const clusterHead = await sliceBlobBytes(
      file,
      firstClusterOffset,
      CLUSTER_PROBE_BYTES,
    );
    const firstBlocks = extractVideoBlocksFromCluster(
      clusterHead,
      firstClusterOffset,
      foundTrack.trackNumber,
      2,
    );
    if (firstBlocks.length === 0) probeTargetUnreadable = true;
    probeBlocks.push(...firstBlocks);
  }
  if (cueTargets.length >= 1) {
    const sampleCueIndices = new Set<number>([
      0,
      Math.floor(cueTargets.length * 0.25),
      Math.floor(cueTargets.length * 0.5),
      Math.floor(cueTargets.length * 0.75),
      cueTargets.length - 1,
    ]);
    for (const idx of sampleCueIndices) {
      const target = cueTargets[idx];
      if (!target) continue;
      const block = await readCueTargetBlock(
        file,
        target,
        foundTrack.trackNumber,
      );
      if (!block) {
        probeTargetUnreadable = true;
      } else {
        probeBlocks.push(block);
      }
    }
  }
  const largeMkvProbeFailed =
    file.size > SMALL_MKV_SCAN_LIMIT &&
    (probeTargetUnreadable || probeBlocks.length === 0);

  const nalLenSize = hvcc.lengthSizeMinusOne + 1;
  let hasInBandParameterSets = false;
  let extraUnparsedSps = false;
  let probedLacedBlock = false;
  const extraSps: ParsedHevcSps[] = [];
  for (const block of probeBlocks) {
    if (block.laced) {
      probedLacedBlock = true;
      continue;
    }
    const inspected = inspectSampleParameterSets(
      block.bytes,
      nalLenSize,
      block.truncated === true,
    );
    if (inspected.hasInBandParameterSets) hasInBandParameterSets = true;
    if (inspected.hasUnparsedSps) extraUnparsedSps = true;
    extraSps.push(...inspected.spsList);
  }

  const containerUnsafeReason = foundTrack.hasContentEncoding
    ? "mkv-content-encoding"
    : tracksCorruptBounds
      ? "mkv-tracks-corrupt-bounds"
      : probedLacedBlock
        ? "mkv-inband-laced-block"
        : null;

  const info = classifyHevcHeader(
    "mkv",
    hvcc,
    extraSps,
    hasInBandParameterSets,
    containerUnsafeReason,
    extraUnparsedSps,
  );

  return {
    container: "mkv",
    info,
    hvcc,
    codecPrivateBytes: foundTrack.codecPrivateBytes,
    codecPrivateFileOffset: foundTrack.codecPrivateFileOffset,
    tracksPayload: tracksEl.payload,
    tracksPayloadOffset: tracksEl.payloadOffset,
    trackEntryPayload: foundTrack.trackEntryPayload,
    trackEntryPayloadOffset: foundTrack.trackEntryPayloadOffset,
    segmentHasCrc32,
    largeMkvProbeFailed,
    trackNumber: foundTrack.trackNumber,
    segmentDataStart,
    firstClusterOffset,
    cueTargets,
  };
}

async function readCueTargetBlock(
  file: Blob,
  cue: MkvCueTarget,
  targetTrack: number,
): Promise<MkvBlockPayload | null> {
  const clusterHdr = await sliceBlobBytes(file, cue.clusterOffset, 16);
  const idInfo = readEbmlId(clusterHdr, 0);
  if (!idInfo || idInfo.id !== EBML_ID_CLUSTER) return null;
  const sizeInfo = readEbmlVint(clusterHdr, idInfo.length);
  if (!sizeInfo) return null;
  const clusterDataStart = cue.clusterOffset + idInfo.length + sizeInfo.length;

  if (cue.relativePosition !== null) {
    const blockOffset = clusterDataStart + cue.relativePosition;
    const blockBuf = await sliceBlobBytes(
      file,
      blockOffset,
      BLOCK_PREFIX_READ_BYTES,
    );
    return parseSingleBlockElement(blockBuf, blockOffset, targetTrack);
  }
  const clusterHead = await sliceBlobBytes(
    file,
    cue.clusterOffset,
    CLUSTER_PROBE_BYTES,
  );
  return (
    extractVideoBlocksFromCluster(
      clusterHead,
      cue.clusterOffset,
      targetTrack,
      1,
    )[0] ?? null
  );
}

export async function patchMkvZeroCopy(
  file: Blob,
  inspection: MkvHevcInspection,
): Promise<ZeroCopyFixResult> {
  if (inspection.info.unsafeReason) {
    return { ok: false, reason: inspection.info.unsafeReason };
  }
  if (inspection.segmentHasCrc32) {
    return { ok: false, reason: "mkv-segment-crc32-unsupported" };
  }

  const hvccRes = patchHvccRecord(inspection.codecPrivateBytes);
  if (!hvccRes.ok) return hvccRes;
  if (!hvccRes.sameLength) return { ok: false, reason: "mkv-length-changed" };

  const codecPrivatePatch: BytePatch = {
    offset: inspection.codecPrivateFileOffset,
    length: inspection.codecPrivateBytes.length,
    bytes: hvccRes.patched,
  };
  const patches: BytePatch[] = [codecPrivatePatch];

  // 由內往外同步更新受影響的 TrackEntry 與 Tracks CRC-32（RFC 8794 §14.2）。
  const tracksInnerPatches: BytePatch[] = [codecPrivatePatch];
  const entryCrc = computeEbmlCrc32Patch(
    inspection.trackEntryPayload,
    inspection.trackEntryPayloadOffset,
    [codecPrivatePatch],
  );
  if (!entryCrc.ok) return entryCrc;
  if (entryCrc.patch) {
    patches.push(entryCrc.patch);
    tracksInnerPatches.push(entryCrc.patch);
  }
  const tracksCrc = computeEbmlCrc32Patch(
    inspection.tracksPayload,
    inspection.tracksPayloadOffset,
    tracksInnerPatches,
  );
  if (!tracksCrc.ok) return tracksCrc;
  if (tracksCrc.patch) patches.push(tracksCrc.patch);

  if (file.size <= SMALL_MKV_SCAN_LIMIT) {
    // 小型 MKV（≤ 4 MB）無論抽查是否命中、也不受頂層 64 元素步數上限影響，
    // 一律從首個 Cluster（若尚未見 Cluster 則從 Segment 起點）完整走訪到檔尾。
    const walkStart =
      inspection.firstClusterOffset ?? inspection.segmentDataStart;
    const segTail = await sliceBlobBytes(
      file,
      walkStart,
      file.size - walkStart,
    );
    const walked = walkSmallMkvClusters(
      segTail,
      walkStart,
      inspection.trackNumber,
    );
    if (!walked.ok) return walked;

    const nalLenSize = inspection.hvcc.lengthSizeMinusOne + 1;
    for (const cluster of walked.clusters) {
      const clusterInnerPatches: BytePatch[] = [];
      for (const block of cluster.blocks) {
        if (block.laced) return { ok: false, reason: "mkv-inband-laced-block" };
        const res = patchSampleParameterSets(block.bytes, nalLenSize);
        if (!res.ok) return { ok: false, reason: res.reason };
        if (res.changed) {
          if (!res.sameLength) {
            return { ok: false, reason: "inband-variable-length" };
          }
          const blockPatch: BytePatch = {
            offset: block.fileOffset,
            length: res.prefixLength,
            bytes: res.patchedPrefix,
          };
          patches.push(blockPatch);
          clusterInnerPatches.push(blockPatch);
          if (block.blockGroup) {
            const bgCrc = computeEbmlCrc32Patch(
              block.blockGroup.payload,
              block.blockGroup.payloadOffset,
              [blockPatch],
            );
            if (!bgCrc.ok) return bgCrc;
            if (bgCrc.patch) {
              patches.push(bgCrc.patch);
              clusterInnerPatches.push(bgCrc.patch);
            }
          }
        }
      }
      if (clusterInnerPatches.length > 0) {
        if (cluster.unknownSize && cluster.hasCrc32) {
          return { ok: false, reason: "mkv-unknown-size-cluster-crc32" };
        }
        const clusterCrc = computeEbmlCrc32Patch(
          cluster.payload,
          cluster.payloadFileOffset,
          clusterInnerPatches,
        );
        if (!clusterCrc.ok) return clusterCrc;
        if (clusterCrc.patch) patches.push(clusterCrc.patch);
      }
    }
  } else if (inspection.info.hasInBandParameterSets) {
    // 依 RFC 9559 §22.1，Matroska Cues 不保證列出同一 Cluster 內的全部關鍵幀；
    // 超過 4 MB 且抽查命中 in-band 時不做多 GB 整檔掃描，改保守降級以避免漏修。
    return { ok: false, reason: "mkv-inband-unverified-coverage" };
  } else if (inspection.largeMkvProbeFailed) {
    return { ok: false, reason: "mkv-probe-unreadable" };
  }

  const blob = spliceZeroCopyBlob(
    file,
    patches,
    file.type || "video/x-matroska",
  );
  return { ok: true, blob, patchedRanges: patches.length };
}
