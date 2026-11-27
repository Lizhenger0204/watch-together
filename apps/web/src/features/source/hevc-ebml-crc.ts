/**
 * EBML IEEE 802.3 CRC-32（RFC 8794 §14.2）驗證與原位重算工具（T-138，ADR 0006）。
 */

import { EBML_ID_CRC32, iterateEbmlChildrenStrict } from "./hevc-ebml";
import type { BytePatch } from "./hevc-patch";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 依 RFC 8794 §14.2 計算 EBML IEEE 802.3 CRC-32。 */
export function computeEbmlCrc32(parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      crc = CRC32_TABLE[(crc ^ part[i]!) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 若該 Master Element 含有直接子元素 CRC-32（0xBF）：
 * 1. 先以嚴格邊界檢查解析全部直接子元素；
 * 2. 依 RFC 8794 §14.2 驗證未修補前原始資料與原 CRC-32 相符（不靜默覆寫已損毀的 CRC）；
 * 3. 套用內部等長修補後重算 4-byte LE CRC-32。
 */
export function computeEbmlCrc32Patch(
  elementPayload: Uint8Array,
  payloadFileOffset: number,
  innerPatches: BytePatch[],
): { ok: true; patch: BytePatch | null } | { ok: false; reason: string } {
  const children = iterateEbmlChildrenStrict(
    elementPayload,
    0,
    elementPayload.length,
  );
  if (!children) {
    return { ok: false, reason: "mkv-crc32-corrupt-parent" };
  }
  const crcChildren = children.filter((child) => child.id === EBML_ID_CRC32);
  if (crcChildren.length === 0) return { ok: true, patch: null };
  if (crcChildren.length > 1) {
    return { ok: false, reason: "mkv-crc32-multiple" };
  }
  const crcEl = crcChildren[0]!;
  if (crcEl.dataEnd - crcEl.dataStart !== 4) {
    return { ok: false, reason: "mkv-crc32-invalid-length" };
  }

  const storedOriginalCrc = new DataView(
    elementPayload.buffer,
    elementPayload.byteOffset + crcEl.dataStart,
    4,
  ).getUint32(0, true);
  const computedOriginalCrc = computeEbmlCrc32([
    elementPayload.subarray(0, crcEl.elementStart),
    elementPayload.subarray(crcEl.dataEnd),
  ]);
  if (storedOriginalCrc !== computedOriginalCrc) {
    return { ok: false, reason: "mkv-original-crc32-invalid" };
  }

  const updated = new Uint8Array(elementPayload);
  for (const patch of innerPatches) {
    if (patch.bytes.length !== patch.length) {
      return { ok: false, reason: "mkv-crc32-variable-length" };
    }
    const relStart = patch.offset - payloadFileOffset;
    const relEnd = relStart + patch.length;
    if (relStart < 0 || relEnd > updated.length) continue;
    if (relStart < crcEl.dataEnd && relEnd > crcEl.elementStart) {
      return { ok: false, reason: "mkv-crc32-overlap" };
    }
    updated.set(patch.bytes, relStart);
  }

  const crc = computeEbmlCrc32([
    updated.subarray(0, crcEl.elementStart),
    updated.subarray(crcEl.dataEnd),
  ]);
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, crc, true);
  return {
    ok: true,
    patch: {
      offset: payloadFileOffset + crcEl.dataStart,
      length: 4,
      bytes,
    },
  };
}
