/**
 * MP4／M4V／MOV 容器的輕量 HEVC 檔頭偵測與零複製修補（T-138，ADR 0006）。
 * 支援 64-bit box size、檔尾或中段 moov、保留原始標頭長度的指定 hvcC 變長重建
 * （逐筆判斷 stco／co64 位移與上界、拒絕變長重建分段 MP4），
 * 以及對 hev1 或檢出 in-band 參數集的非分段 MP4 依 stsz 完整掃描並等長修補全部樣本。
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
const MAX_INBAND_SAMPLES = 2_000;

export interface Mp4SampleRange {
  offset: number;
  size: number;
}

export interface Mp4HevcInspection {
  container: "mp4";
  info: HevcProfileSummary;
  sampleEntryType: "hvc1" | "hev1";
  isFragmented: boolean;
  scannedAllTopLevelBoxes: boolean;
  hvcc: ParsedHvcc;
  hvccBytes: Uint8Array;
  hvccFileOffset: number;
  /** 選中 hvcC box 在 moovBytes 內的起始偏移，避免變長重建誤改其他軌道／entry 的 hvcC。 */
  hvccBoxMoovOffset: number;
  moovOffset: number;
  moovSize: number;
  moovBytes: Uint8Array;
  keyframes: Mp4SampleRange[];
  allSamples: Mp4SampleRange[];
  sampleCount: number;
  hasFullSampleIndex: boolean;
}

function resolveMp4Samples(
  moov: Uint8Array,
  stbl: Mp4Box,
): {
  keyframes: Mp4SampleRange[];
  allSamples: Mp4SampleRange[];
  sampleCount: number;
  hasFullSampleIndex: boolean;
} {
  const empty = {
    keyframes: [],
    allSamples: [],
    sampleCount: 0,
    hasFullSampleIndex: false,
  };
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const stscBox = findChildBox(moov, stbl, "stsc");
  const stszBox = findChildBox(moov, stbl, "stsz");
  const stcoBox = findChildBox(moov, stbl, "stco");
  const co64Box = findChildBox(moov, stbl, "co64");
  const stssBox = findChildBox(moov, stbl, "stss");
  if (!stscBox || !stszBox || (!stcoBox && !co64Box)) return empty;

  const chunkOffsets: number[] = [];
  if (stcoBox && stcoBox.payloadStart + 8 <= stcoBox.end) {
    const count = view.getUint32(stcoBox.payloadStart + 4, false);
    if (stcoBox.payloadStart + 8 + count * 4 > stcoBox.end) return empty;
    for (let i = 0; i < count; i += 1) {
      chunkOffsets.push(
        view.getUint32(stcoBox.payloadStart + 8 + i * 4, false),
      );
    }
  } else if (co64Box && co64Box.payloadStart + 8 <= co64Box.end) {
    const count = view.getUint32(co64Box.payloadStart + 4, false);
    if (co64Box.payloadStart + 8 + count * 8 > co64Box.end) return empty;
    for (let i = 0; i < count; i += 1) {
      const val = view.getBigUint64(co64Box.payloadStart + 8 + i * 8, false);
      if (val > BigInt(Number.MAX_SAFE_INTEGER)) return empty;
      chunkOffsets.push(Number(val));
    }
  }

  if (stszBox.payloadStart + 12 > stszBox.end) return empty;
  const fixedSampleSize = view.getUint32(stszBox.payloadStart + 4, false);
  const sampleCount = view.getUint32(stszBox.payloadStart + 8, false);
  if (
    fixedSampleSize === 0 &&
    stszBox.payloadStart + 12 + sampleCount * 4 > stszBox.end
  ) {
    return empty;
  }
  const sampleSizeAt = (idx0: number): number => {
    if (fixedSampleSize !== 0) return fixedSampleSize;
    return view.getUint32(stszBox.payloadStart + 12 + idx0 * 4, false);
  };

  const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
  if (stscBox.payloadStart + 8 <= stscBox.end) {
    const count = view.getUint32(stscBox.payloadStart + 4, false);
    if (stscBox.payloadStart + 8 + count * 12 > stscBox.end) return empty;
    for (let i = 0; i < count; i += 1) {
      const base = stscBox.payloadStart + 8 + i * 12;
      stscEntries.push({
        firstChunk: view.getUint32(base, false),
        samplesPerChunk: view.getUint32(base + 4, false),
      });
    }
  }
  if (stscEntries.length === 0 || chunkOffsets.length === 0) return empty;

  let syncSamples: number[];
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
  } else {
    syncSamples = sampleCount > 0 ? [1] : [];
  }
  if (sampleCount === 0) return empty;

  const targetSet = new Set(syncSamples);
  const collectAll = sampleCount <= MAX_INBAND_SAMPLES;
  const keyframes: Mp4SampleRange[] = [];
  const allSamples: Mp4SampleRange[] = [];
  let sampleNumber = 1;
  let stscIdx = 0;

  for (
    let chunkIndex = 1;
    chunkIndex <= chunkOffsets.length &&
    sampleNumber <= sampleCount &&
    (collectAll || keyframes.length < targetSet.size);
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
      const range = { offset: fileOffset, size };
      if (collectAll) allSamples.push(range);
      if (targetSet.has(sampleNumber)) keyframes.push(range);
      fileOffset += size;
      sampleNumber += 1;
    }
  }

  return {
    keyframes,
    allSamples,
    sampleCount,
    hasFullSampleIndex: collectAll && allSamples.length === sampleCount,
  };
}

export async function inspectMp4Hevc(
  file: Blob,
): Promise<Mp4HevcInspection | null> {
  let offset = 0;
  let moovOffset = -1;
  let moovSize = 0;
  let isMp4 = false;
  let isFragmented = false;

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
    if (type === "moof" || type === "sidx" || type === "mfra") {
      isFragmented = true;
    }
    if (type === "moov" && moovOffset === -1) {
      moovOffset = offset;
      moovSize = size;
    }
    offset += size;
  }
  const scannedAllTopLevelBoxes = offset === file.size;

  if (!isMp4 || moovOffset < 0 || moovSize > MAX_MOOV_BYTES) return null;

  const moovBytes = await sliceBlobBytes(file, moovOffset, moovSize);
  const moovBox = parseMp4Boxes(moovBytes, 0, moovBytes.length)[0];
  if (!moovBox || moovBox.type !== "moov") return null;
  if (findChildBox(moovBytes, moovBox, "mvex")) isFragmented = true;

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

      const { keyframes, allSamples, sampleCount, hasFullSampleIndex } =
        resolveMp4Samples(moovBytes, stbl);
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
        const isTruncatedWindow = sampleHead.length < kf.size;
        const inspected = inspectSampleParameterSets(
          sampleHead,
          nalLenSize,
          isTruncatedWindow,
        );
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
        sampleEntryType: entry.type,
        isFragmented,
        scannedAllTopLevelBoxes,
        hvcc,
        hvccBytes: new Uint8Array(hvccBytes),
        hvccFileOffset: moovOffset + hvccBox.payloadStart,
        hvccBoxMoovOffset: hvccBox.offset,
        moovOffset,
        moovSize,
        moovBytes,
        keyframes,
        allSamples,
        sampleCount,
        hasFullSampleIndex,
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

  const needsSampleScan =
    inspection.sampleEntryType === "hev1" ||
    inspection.info.hasInBandParameterSets;

  const patches: BytePatch[] = [];
  if (hvccRes.sameLength) {
    patches.push({
      offset: inspection.hvccFileOffset,
      length: inspection.hvccBytes.length,
      bytes: hvccRes.patched,
    });
  } else {
    if (inspection.isFragmented) {
      return { ok: false, reason: "mp4-fragmented-variable-length" };
    }
    if (!inspection.scannedAllTopLevelBoxes) {
      return { ok: false, reason: "mp4-unscanned-top-level-boxes" };
    }
    if (needsSampleScan) {
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

  if (needsSampleScan) {
    if (inspection.isFragmented) {
      return { ok: false, reason: "mp4-fragmented-inband-unsupported" };
    }
    if (inspection.sampleCount > MAX_INBAND_SAMPLES) {
      return { ok: false, reason: "too-many-inband-samples" };
    }
    if (!inspection.hasFullSampleIndex) {
      return { ok: false, reason: "mp4-inband-missing-sample-table" };
    }
    const nalLenSize = inspection.hvcc.lengthSizeMinusOne + 1;
    for (const sample of inspection.allSamples) {
      const readLen = Math.min(sample.size, KEYFRAME_PROBE_BYTES);
      if (readLen <= 0) continue;
      const sampleHead = await sliceBlobBytes(file, sample.offset, readLen);
      const isTruncatedWindow = sampleHead.length < sample.size;
      const patched = patchSampleParameterSets(
        sampleHead,
        nalLenSize,
        isTruncatedWindow,
      );
      if (!patched.ok) return { ok: false, reason: patched.reason };
      if (patched.changed) {
        if (!patched.sameLength) {
          return { ok: false, reason: "inband-variable-length" };
        }
        patches.push({
          offset: sample.offset,
          length: patched.prefixLength,
          bytes: patched.patchedPrefix,
        });
      }
    }
  }

  const blob = spliceZeroCopyBlob(file, patches, file.type || "video/mp4");
  return { ok: true, blob, patchedRanges: patches.length };
}
