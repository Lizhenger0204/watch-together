/**
 * MP4／M4V／MOV 容器的輕量 HEVC 檔頭偵測與零複製修補（T-138，ADR 0006）。
 * 支援 64-bit box size、檔尾或中段 moov、保留原始標頭長度的指定 hvcC 變長重建
 * （逐筆判斷 stco／co64 位移與上界）以及依 stsz 邊界精準修補有索引的等長 in-band 參數集。
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
  findChildBox,
  parseMp4Boxes,
  readFourCC,
  rebuildMp4MoovWithHvcc,
  type Mp4Box,
} from "./hevc-mp4-boxes";
import {
  patchHvccRecord,
  patchSampleParameterSets,
  sliceBlobBytes,
  spliceZeroCopyBlob,
  type BytePatch,
  type ZeroCopyFixResult,
} from "./hevc-patch";

const MAX_MOOV_BYTES = 32 * 1024 * 1024;
const KEYFRAME_PROBE_BYTES = 64 * 1024;
const MAX_INBAND_KEYFRAMES = 2_000;

export interface Mp4SampleRange {
  offset: number;
  size: number;
}

export interface Mp4HevcInspection {
  container: "mp4";
  info: HevcProfileSummary;
  hvcc: ParsedHvcc;
  hvccBytes: Uint8Array;
  hvccFileOffset: number;
  /** 選中 hvcC box 在 moovBytes 內的起始偏移，避免變長重建誤改其他軌道／entry 的 hvcC。 */
  hvccBoxMoovOffset: number;
  moovOffset: number;
  moovSize: number;
  moovBytes: Uint8Array;
  keyframes: Mp4SampleRange[];
  hasFullKeyframeIndex: boolean;
}

function resolveMp4Keyframes(
  moov: Uint8Array,
  stbl: Mp4Box,
): { keyframes: Mp4SampleRange[]; hasFullIndex: boolean } {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const stscBox = findChildBox(moov, stbl, "stsc");
  const stszBox = findChildBox(moov, stbl, "stsz");
  const stcoBox = findChildBox(moov, stbl, "stco");
  const co64Box = findChildBox(moov, stbl, "co64");
  const stssBox = findChildBox(moov, stbl, "stss");
  if (!stscBox || !stszBox || (!stcoBox && !co64Box)) {
    return { keyframes: [], hasFullIndex: false };
  }

  const chunkOffsets: number[] = [];
  if (stcoBox && stcoBox.payloadStart + 8 <= stcoBox.end) {
    const count = view.getUint32(stcoBox.payloadStart + 4, false);
    for (
      let i = 0;
      i < count && stcoBox.payloadStart + 8 + (i + 1) * 4 <= stcoBox.end;
      i += 1
    ) {
      chunkOffsets.push(
        view.getUint32(stcoBox.payloadStart + 8 + i * 4, false),
      );
    }
  } else if (co64Box && co64Box.payloadStart + 8 <= co64Box.end) {
    const count = view.getUint32(co64Box.payloadStart + 4, false);
    for (
      let i = 0;
      i < count && co64Box.payloadStart + 8 + (i + 1) * 8 <= co64Box.end;
      i += 1
    ) {
      const val = view.getBigUint64(co64Box.payloadStart + 8 + i * 8, false);
      if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { keyframes: [], hasFullIndex: false };
      }
      chunkOffsets.push(Number(val));
    }
  }

  if (stszBox.payloadStart + 12 > stszBox.end) {
    return { keyframes: [], hasFullIndex: false };
  }
  const fixedSampleSize = view.getUint32(stszBox.payloadStart + 4, false);
  const sampleCount = view.getUint32(stszBox.payloadStart + 8, false);
  const sampleSizeAt = (idx0: number): number => {
    if (fixedSampleSize !== 0) return fixedSampleSize;
    const pos = stszBox.payloadStart + 12 + idx0 * 4;
    return pos + 4 <= stszBox.end ? view.getUint32(pos, false) : 0;
  };

  const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
  if (stscBox.payloadStart + 8 <= stscBox.end) {
    const count = view.getUint32(stscBox.payloadStart + 4, false);
    for (
      let i = 0;
      i < count && stscBox.payloadStart + 8 + (i + 1) * 12 <= stscBox.end;
      i += 1
    ) {
      const base = stscBox.payloadStart + 8 + i * 12;
      stscEntries.push({
        firstChunk: view.getUint32(base, false),
        samplesPerChunk: view.getUint32(base + 4, false),
      });
    }
  }
  if (stscEntries.length === 0 || chunkOffsets.length === 0) {
    return { keyframes: [], hasFullIndex: false };
  }

  let syncSamples: number[];
  let hasFullIndex = false;
  if (stssBox && stssBox.payloadStart + 8 <= stssBox.end) {
    const count = view.getUint32(stssBox.payloadStart + 4, false);
    syncSamples = [];
    for (
      let i = 0;
      i < count && stssBox.payloadStart + 8 + (i + 1) * 4 <= stssBox.end;
      i += 1
    ) {
      syncSamples.push(view.getUint32(stssBox.payloadStart + 8 + i * 4, false));
    }
    hasFullIndex = syncSamples.length === count && count > 0;
  } else {
    syncSamples = sampleCount > 0 ? [1] : [];
  }
  if (syncSamples.length === 0) return { keyframes: [], hasFullIndex: false };

  const targetSet = new Set(syncSamples);
  const keyframes: Mp4SampleRange[] = [];
  let sampleNumber = 1;
  let stscIdx = 0;

  for (
    let chunkIndex = 1;
    chunkIndex <= chunkOffsets.length && keyframes.length < targetSet.size;
    chunkIndex += 1
  ) {
    while (
      stscIdx + 1 < stscEntries.length &&
      stscEntries[stscIdx + 1]!.firstChunk <= chunkIndex
    ) {
      stscIdx += 1;
    }
    const perChunk = stscEntries[stscIdx]!.samplesPerChunk;
    let fileOffset = chunkOffsets[chunkIndex - 1]!;
    for (let s = 0; s < perChunk && sampleNumber <= sampleCount; s += 1) {
      const size = sampleSizeAt(sampleNumber - 1);
      if (targetSet.has(sampleNumber)) {
        keyframes.push({ offset: fileOffset, size });
      }
      fileOffset += size;
      sampleNumber += 1;
    }
  }

  return {
    keyframes,
    hasFullIndex: hasFullIndex && keyframes.length === targetSet.size,
  };
}

export async function inspectMp4Hevc(
  file: Blob,
): Promise<Mp4HevcInspection | null> {
  let offset = 0;
  let moovOffset = -1;
  let moovSize = 0;
  let isMp4 = false;

  for (let steps = 0; steps < 256 && offset + 8 <= file.size; steps += 1) {
    const hdr = await sliceBlobBytes(file, offset, 16);
    if (hdr.length < 8) break;
    const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    let size = view.getUint32(0, false);
    const type = readFourCC(hdr, 4);
    let headerSize = 8;
    if (size === 1) {
      if (hdr.length < 16) break;
      const bigSize = view.getBigUint64(8, false);
      if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(bigSize);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < headerSize || offset + size > file.size) break;
    if (type === "ftyp" || type === "moov" || type === "mdat") isMp4 = true;
    if (type === "moov" && moovOffset === -1) {
      moovOffset = offset;
      moovSize = size;
    }
    offset += size;
  }

  if (!isMp4 || moovOffset < 0 || moovSize > MAX_MOOV_BYTES) return null;

  const moovBytes = await sliceBlobBytes(file, moovOffset, moovSize);
  const moovBox = parseMp4Boxes(moovBytes, 0, moovBytes.length)[0];
  if (!moovBox || moovBox.type !== "moov") return null;

  for (const trak of parseMp4Boxes(
    moovBytes,
    moovBox.payloadStart,
    moovBox.end,
  )) {
    if (trak.type !== "trak") continue;
    const mdia = findChildBox(moovBytes, trak, "mdia");
    const minf = mdia ? findChildBox(moovBytes, mdia, "minf") : undefined;
    const stbl = minf ? findChildBox(moovBytes, minf, "stbl") : undefined;
    const stsd = stbl ? findChildBox(moovBytes, stbl, "stsd") : undefined;
    if (!stbl || !stsd || stsd.payloadStart + 8 > stsd.end) continue;

    for (const entry of parseMp4Boxes(
      moovBytes,
      stsd.payloadStart + 8,
      stsd.end,
    )) {
      if (entry.type !== "hvc1" && entry.type !== "hev1") continue;
      if (entry.payloadStart + 78 > entry.end) continue;
      const hvccBox = parseMp4Boxes(
        moovBytes,
        entry.payloadStart + 78,
        entry.end,
      ).find((child) => child.type === "hvcC");
      if (!hvccBox) continue;

      const hvccBytes = moovBytes.subarray(hvccBox.payloadStart, hvccBox.end);
      const hvcc = parseHvcc(hvccBytes);
      if (!hvcc) continue;

      const { keyframes, hasFullIndex } = resolveMp4Keyframes(moovBytes, stbl);
      const nalLenSize = hvcc.lengthSizeMinusOne + 1;
      const probeIndexes =
        keyframes.length >= 2
          ? [0, Math.floor(keyframes.length / 2)]
          : keyframes.length === 1
            ? [0]
            : [];

      let hasInBandParameterSets = false;
      let extraUnparsedSps = false;
      const extraSps: ParsedHevcSps[] = [];
      for (const idx of probeIndexes) {
        const kf = keyframes[idx]!;
        const readLen = Math.min(kf.size, KEYFRAME_PROBE_BYTES);
        if (readLen <= 0) continue;
        const sampleHead = await sliceBlobBytes(file, kf.offset, readLen);
        const inspected = inspectSampleParameterSets(sampleHead, nalLenSize);
        if (inspected.hasInBandParameterSets) hasInBandParameterSets = true;
        if (inspected.hasUnparsedSps) extraUnparsedSps = true;
        extraSps.push(...inspected.spsList);
      }

      const info = classifyHevcHeader(
        "mp4",
        hvcc,
        extraSps,
        hasInBandParameterSets,
        null,
        extraUnparsedSps,
      );
      return {
        container: "mp4",
        info,
        hvcc,
        hvccBytes: new Uint8Array(hvccBytes),
        hvccFileOffset: moovOffset + hvccBox.payloadStart,
        hvccBoxMoovOffset: hvccBox.offset,
        moovOffset,
        moovSize,
        moovBytes,
        keyframes,
        hasFullKeyframeIndex: hasFullIndex,
      };
    }
  }

  return null;
}

export async function patchMp4ZeroCopy(
  file: Blob,
  inspection: Mp4HevcInspection,
): Promise<ZeroCopyFixResult> {
  if (inspection.info.unsafeReason) {
    return { ok: false, reason: inspection.info.unsafeReason };
  }
  const hvccRes = patchHvccRecord(inspection.hvccBytes);
  if (!hvccRes.ok) return hvccRes;

  const patches: BytePatch[] = [];
  if (hvccRes.sameLength) {
    patches.push({
      offset: inspection.hvccFileOffset,
      length: inspection.hvccBytes.length,
      bytes: hvccRes.patched,
    });
  } else {
    if (inspection.info.hasInBandParameterSets) {
      return { ok: false, reason: "mp4-hvcc-length-changed-with-inband" };
    }
    const rebuiltMoov = rebuildMp4MoovWithHvcc(
      inspection.moovBytes,
      inspection.hvccBoxMoovOffset,
      hvccRes.patched,
      inspection.moovOffset,
      inspection.moovOffset + inspection.moovSize,
    );
    if (!rebuiltMoov) return { ok: false, reason: "mp4-moov-offset-overflow" };
    patches.push({
      offset: inspection.moovOffset,
      length: inspection.moovSize,
      bytes: rebuiltMoov,
    });
  }

  if (inspection.info.hasInBandParameterSets) {
    if (!inspection.hasFullKeyframeIndex) {
      return { ok: false, reason: "mp4-inband-missing-stss" };
    }
    if (inspection.keyframes.length > MAX_INBAND_KEYFRAMES) {
      return { ok: false, reason: "too-many-inband-keyframes" };
    }
    const nalLenSize = inspection.hvcc.lengthSizeMinusOne + 1;
    for (const kf of inspection.keyframes) {
      const readLen = Math.min(kf.size, KEYFRAME_PROBE_BYTES);
      if (readLen <= 0) continue;
      const sampleHead = await sliceBlobBytes(file, kf.offset, readLen);
      const patched = patchSampleParameterSets(sampleHead, nalLenSize);
      if (!patched.ok) return { ok: false, reason: patched.reason };
      if (patched.changed) {
        if (!patched.sameLength) {
          return { ok: false, reason: "inband-variable-length" };
        }
        patches.push({
          offset: kf.offset,
          length: patched.prefixLength,
          bytes: patched.patchedPrefix,
        });
      }
    }
  }

  const blob = spliceZeroCopyBlob(file, patches, file.type || "video/mp4");
  return { ok: true, blob, patchedRanges: patches.length };
}
