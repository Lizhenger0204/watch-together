/**
 * MP4／ISOBMFF 低階 box 解析、保留原始標頭長度的變長 moov 重建與 stco／co64 位移（T-138，ADR 0006）。
 */

import { concatUint8Arrays } from "./hevc-patch";

const MAX_U64 = 0xffffffffffffffffn;

export interface Mp4Box {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
  payloadStart: number;
  end: number;
}

const MP4_CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
]);

const MP4_OFFSET_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

export function readFourCC(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(
    buf[offset]!,
    buf[offset + 1]!,
    buf[offset + 2]!,
    buf[offset + 3]!,
  );
}

export function parseMp4Boxes(
  buf: Uint8Array,
  start: number,
  end: number,
): Mp4Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false);
    const type = readFourCC(buf, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const bigSize = view.getBigUint64(offset + 8, false);
      if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(bigSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({
      type,
      offset,
      size,
      headerSize,
      payloadStart: offset + headerSize,
      end: offset + size,
    });
    offset += size;
  }
  return boxes;
}

export function findChildBox(buf: Uint8Array, parent: Mp4Box, type: string) {
  return parseMp4Boxes(buf, parent.payloadStart, parent.end).find(
    (box) => box.type === type,
  );
}

function parseMp4BoxesStrict(
  buf: Uint8Array,
  start: number,
  end: number,
): Mp4Box[] | null {
  const boxes = parseMp4Boxes(buf, start, end);
  const covered = boxes.length === 0 ? start : boxes[boxes.length - 1]!.end;
  return covered === end ? boxes : null;
}

function makeMp4BoxWithHeader(
  type: string,
  payload: Uint8Array,
  headerSize: number,
): Uint8Array | null {
  if (headerSize === 16) {
    const out = new Uint8Array(16 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 1, false);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    view.setBigUint64(8, BigInt(out.length), false);
    out.set(payload, 16);
    return out;
  }
  if (headerSize !== 8 || 8 + payload.length > 0xffffffff) return null;
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/**
 * 僅替換位於 targetHvccBoxOffset 的那一個 hvcC，保留每一層箱原有的 8/16-byte 標頭長度，
 * 並依每筆 chunk offset 是否位於 moov 區段後方（>= moovEnd）決定平移，最後驗證輸出總長一致。
 */
export function rebuildMp4MoovWithHvcc(
  moovBytes: Uint8Array,
  targetHvccBoxOffset: number,
  patchedHvcc: Uint8Array,
  moovStart: number,
  moovEnd: number,
): Uint8Array | null {
  let replaced = false;
  let invalidStructure = false;

  function transform(boxStart: number, boxEnd: number): Uint8Array {
    const boxBuf = moovBytes.subarray(boxStart, boxEnd);
    if (targetHvccBoxOffset < boxStart || targetHvccBoxOffset >= boxEnd) {
      return boxBuf;
    }
    const view = new DataView(
      boxBuf.buffer,
      boxBuf.byteOffset,
      boxBuf.byteLength,
    );
    const headerSize = view.getUint32(0, false) === 1 ? 16 : 8;
    const type = readFourCC(boxBuf, 4);
    if (type === "hvcC" && boxStart === targetHvccBoxOffset) {
      const rebuiltHvcc = makeMp4BoxWithHeader("hvcC", patchedHvcc, headerSize);
      if (!rebuiltHvcc) {
        invalidStructure = true;
        return boxBuf;
      }
      replaced = true;
      return rebuiltHvcc;
    }
    if (type === "stsd") {
      const prefix = boxBuf.subarray(headerSize, headerSize + 8);
      const parsed = parseMp4BoxesStrict(
        moovBytes,
        boxStart + headerSize + 8,
        boxEnd,
      );
      if (!parsed) {
        invalidStructure = true;
        return boxBuf;
      }
      const children = parsed.map((child) =>
        transform(child.offset, child.end),
      );
      const rebuilt = makeMp4BoxWithHeader(
        "stsd",
        concatUint8Arrays([prefix, ...children]),
        headerSize,
      );
      if (!rebuilt) {
        invalidStructure = true;
        return boxBuf;
      }
      return rebuilt;
    }
    if (type === "hvc1" || type === "hev1") {
      const fixed = boxBuf.subarray(headerSize, headerSize + 78);
      const parsed = parseMp4BoxesStrict(
        moovBytes,
        boxStart + headerSize + 78,
        boxEnd,
      );
      if (!parsed) {
        invalidStructure = true;
        return boxBuf;
      }
      const children = parsed.map((child) =>
        transform(child.offset, child.end),
      );
      const rebuilt = makeMp4BoxWithHeader(
        type,
        concatUint8Arrays([fixed, ...children]),
        headerSize,
      );
      if (!rebuilt) {
        invalidStructure = true;
        return boxBuf;
      }
      return rebuilt;
    }
    if (MP4_CONTAINERS.has(type)) {
      const parsed = parseMp4BoxesStrict(
        moovBytes,
        boxStart + headerSize,
        boxEnd,
      );
      if (!parsed) {
        invalidStructure = true;
        return boxBuf;
      }
      const children = parsed.map((child) =>
        transform(child.offset, child.end),
      );
      const rebuilt = makeMp4BoxWithHeader(
        type,
        concatUint8Arrays(children),
        headerSize,
      );
      if (!rebuilt) {
        invalidStructure = true;
        return boxBuf;
      }
      return rebuilt;
    }
    return boxBuf;
  }

  let invalidOffset = false;
  function applyDelta(boxBuf: Uint8Array, delta: number): Uint8Array {
    if (delta === 0) return boxBuf;
    const view = new DataView(
      boxBuf.buffer,
      boxBuf.byteOffset,
      boxBuf.byteLength,
    );
    const headerSize = view.getUint32(0, false) === 1 ? 16 : 8;
    const type = readFourCC(boxBuf, 4);
    if (type === "stco") {
      const out = new Uint8Array(boxBuf);
      const outView = new DataView(out.buffer);
      if (headerSize + 8 > out.length) {
        invalidOffset = true;
        return out;
      }
      const count = outView.getUint32(headerSize + 4, false);
      if (headerSize + 8 + count * 4 > out.length) {
        invalidOffset = true;
        return out;
      }
      for (let i = 0; i < count; i += 1) {
        const pos = headerSize + 8 + i * 4;
        const current = outView.getUint32(pos, false);
        if (current >= moovStart && current < moovEnd) {
          invalidOffset = true;
          return out;
        }
        if (current >= moovEnd) {
          const next = current + delta;
          if (next < 0 || next > 0xffffffff) {
            invalidOffset = true;
            return out;
          }
          outView.setUint32(pos, next, false);
        }
      }
      return out;
    }
    if (type === "co64") {
      const out = new Uint8Array(boxBuf);
      const outView = new DataView(out.buffer);
      if (headerSize + 8 > out.length) {
        invalidOffset = true;
        return out;
      }
      const count = outView.getUint32(headerSize + 4, false);
      if (headerSize + 8 + count * 8 > out.length) {
        invalidOffset = true;
        return out;
      }
      const moovStartBig = BigInt(moovStart);
      const moovEndBig = BigInt(moovEnd);
      const deltaBig = BigInt(delta);
      for (let i = 0; i < count; i += 1) {
        const pos = headerSize + 8 + i * 8;
        const current = outView.getBigUint64(pos, false);
        if (current >= moovStartBig && current < moovEndBig) {
          invalidOffset = true;
          return out;
        }
        if (current >= moovEndBig) {
          const next = current + deltaBig;
          if (next < 0n || next > MAX_U64) {
            invalidOffset = true;
            return out;
          }
          outView.setBigUint64(pos, next, false);
        }
      }
      return out;
    }
    if (MP4_OFFSET_CONTAINERS.has(type)) {
      const parsed = parseMp4BoxesStrict(boxBuf, headerSize, boxBuf.length);
      if (!parsed) {
        invalidOffset = true;
        return boxBuf;
      }
      const children = parsed.map((child) =>
        applyDelta(boxBuf.subarray(child.offset, child.end), delta),
      );
      const rebuilt = makeMp4BoxWithHeader(
        type,
        concatUint8Arrays(children),
        headerSize,
      );
      if (!rebuilt) {
        invalidOffset = true;
        return boxBuf;
      }
      return rebuilt;
    }
    return boxBuf;
  }

  const rebuilt = transform(0, moovBytes.length);
  if (!replaced || invalidStructure) return null;
  const delta = rebuilt.length - moovBytes.length;
  if (delta === 0) return rebuilt;
  const shifted = applyDelta(rebuilt, delta);
  if (invalidOffset || shifted.length !== moovBytes.length + delta) return null;
  return shifted;
}
