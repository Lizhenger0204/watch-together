import { describe, expect, it } from "vitest";
import {
  HEVC_NAL_SPS,
  HEVC_PROFILE_MAIN_10,
  rbspToEbsp,
} from "./hevc-bitstream";
import { buildZeroCopyHevcProfileFix, inspectHevcProfile } from "./hevc-header";

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function ebmlVint(value: number): Uint8Array<ArrayBuffer> {
  if (value < 0x7f) return new Uint8Array([0x80 | value]);
  if (value < 0x3fff) {
    return new Uint8Array([0x40 | (value >> 8), value & 0xff]);
  }
  if (value < 0x1fffff) {
    return new Uint8Array([
      0x20 | (value >> 16),
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
  return new Uint8Array([
    0x10 | (value >> 24),
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

function ebmlEl(
  idBytes: number[],
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array(idBytes), ebmlVint(payload.length), payload);
}

function encodeUint(value: number): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return new Uint8Array(bytes);
}

function makeMalformedHvcc(): Uint8Array<ArrayBuffer> {
  const bits: number[] = [];
  const push = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  const pushUe = (val: number) => {
    const code = val + 1;
    const leading = Math.floor(Math.log2(code));
    for (let i = 0; i < leading; i += 1) bits.push(0);
    push(code, leading + 1);
  };
  push(0, 4);
  push(0, 3);
  push(1, 1);
  push(0, 2);
  push(0, 1);
  push(HEVC_PROFILE_MAIN_10, 5);
  push(0x20, 8);
  for (let i = 0; i < 9; i += 1) push(0, 8);
  push(93, 8);
  pushUe(0);
  pushUe(1);
  pushUe(160);
  pushUe(96);
  push(0, 1);
  pushUe(0);
  pushUe(0);
  push(1, 1);
  while (bits.length % 8 !== 0) bits.push(0);
  const rbsp = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) {
    rbsp[i >> 3] = (rbsp[i >> 3] ?? 0) | (bits[i]! << (7 - (i & 7)));
  }
  const sps = concat(
    new Uint8Array([(HEVC_NAL_SPS << 1) & 0x7e, 0x01]),
    rbspToEbsp(rbsp),
  );
  const hvcc = new Uint8Array(23 + 5 + sps.length);
  hvcc[0] = 1;
  hvcc[1] = HEVC_PROFILE_MAIN_10;
  hvcc[2] = 0x20;
  hvcc[12] = 93;
  hvcc[16] = 0xfd;
  hvcc[17] = 0xf8;
  hvcc[18] = 0xf8;
  hvcc[21] = 0x03;
  hvcc[22] = 1;
  hvcc[23] = 0x80 | HEVC_NAL_SPS;
  hvcc[24] = 0;
  hvcc[25] = 1;
  hvcc[26] = (sps.length >> 8) & 0xff;
  hvcc[27] = sps.length & 0xff;
  hvcc.set(sps, 28);
  return hvcc;
}

describe("hevc container R10 EOF truncation and Cue cluster tail validation", () => {
  const ebmlHeader = ebmlEl(
    [0x1a, 0x45, 0xdf, 0xa3],
    new Uint8Array([0x42, 0x86, 0x81, 0x01]),
  );
  const segHdrUnknown = new Uint8Array([
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  const tracks = ebmlEl(
    [0x16, 0x54, 0xae, 0x6b],
    ebmlEl(
      [0xae],
      concat(
        ebmlEl([0xd7], new Uint8Array([1])),
        ebmlEl([0x83], new Uint8Array([1])),
        ebmlEl([0x86], new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
        ebmlEl([0x63, 0xa2], makeMalformedHvcc()),
      ),
    ),
  );
  const tcEl = ebmlEl([0xe7], new Uint8Array([0]));
  const vclBlockBody = new Uint8Array([
    0x81, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x04, 0x26, 0x01, 0xde, 0xad,
  ]);
  const cleanSimpleBlock = ebmlEl([0xa3], vclBlockBody);
  const validBlockInBg = ebmlEl([0xa1], vclBlockBody);
  const cleanCluster = ebmlEl(
    [0x1f, 0x43, 0xb6, 0x75],
    concat(tcEl, cleanSimpleBlock),
  );
  const pad45MB = new Uint8Array(4_500_000);

  const makeCue = (clusterPos: number, relPos?: number) => {
    const posFields = [
      ebmlEl([0xf7], new Uint8Array([1])),
      ebmlEl([0xf1], encodeUint(clusterPos)),
      ...(relPos !== undefined ? [ebmlEl([0xf0], encodeUint(relPos))] : []),
    ];
    return ebmlEl(
      [0x1c, 0x53, 0xbb, 0x6b],
      ebmlEl(
        [0xbb],
        concat(
          ebmlEl([0xb3], new Uint8Array([0])),
          ebmlEl([0xb7], concat(...posFields)),
        ),
      ),
    );
  };

  it("refuses large MKV when fixed-size Cluster/BlockGroup is truncated at EOF on all three probe paths", async () => {
    // 完整 Cluster 內含有效 BlockGroup + 128-byte Void，但在 EC 40 後截斷檔尾（缺少末 byte 與 128 bytes payload）
    const fullBg = ebmlEl(
      [0xa0],
      concat(validBlockInBg, ebmlEl([0xec], new Uint8Array(128))),
    );
    const fullCluster = ebmlEl([0x1f, 0x43, 0xb6, 0x75], concat(tcEl, fullBg));
    // 截掉最後 129 bytes，使實際檔尾正好落在 EC 40
    const eofTruncatedCluster = fullCluster.subarray(
      0,
      fullCluster.length - 129,
    );
    const bigVoid = ebmlEl([0xec], pad45MB);

    // 路徑 1：首 Cluster 本身在檔尾截斷（前方以 4.5 MB Void 撐大檔案）
    const firstClusterEofBlob = new Blob(
      [ebmlHeader, segHdrUnknown, tracks, bigVoid, eofTruncatedCluster],
      { type: "video/x-matroska" },
    );

    // 路徑 2：無相對位置 Cue 指向檔尾截斷的 Cluster
    const buildCueEof = (withRel: boolean) => {
      let cues = makeCue(0, withRel ? tcEl.length : undefined);
      let targetPos =
        tracks.length + cues.length + cleanCluster.length + bigVoid.length;
      cues = makeCue(targetPos, withRel ? tcEl.length : undefined);
      targetPos =
        tracks.length + cues.length + cleanCluster.length + bigVoid.length;
      cues = makeCue(targetPos, withRel ? tcEl.length : undefined);
      return new Blob(
        [
          ebmlHeader,
          segHdrUnknown,
          tracks,
          cues,
          cleanCluster,
          bigVoid,
          eofTruncatedCluster,
        ],
        { type: "video/x-matroska" },
      );
    };

    // 路徑 4：未知長度 Cluster 在檔尾只剩截斷的 EC 40
    const unknownClusterEof = concat(
      new Uint8Array([
        0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ]),
      tcEl,
      cleanSimpleBlock,
      new Uint8Array([0xec, 0x40]),
    );
    const unknownClusterEofBlob = new Blob(
      [ebmlHeader, segHdrUnknown, tracks, bigVoid, unknownClusterEof],
      { type: "video/x-matroska" },
    );

    for (const blob of [
      firstClusterEofBlob,
      buildCueEof(false),
      buildCueEof(true),
      unknownClusterEofBlob,
    ]) {
      const insp = await inspectHevcProfile(blob);
      expect(insp?.container).toBe("mkv");
      expect(await buildZeroCopyHevcProfileFix(blob, insp!)).toEqual({
        ok: false,
        reason: "mkv-probe-unreadable",
      });
    }
  });

  it("refuses Cue without relativePosition when an out-of-bounds Void follows the first valid SimpleBlock", async () => {
    // Cluster 內為：Timecode + 有效 SimpleBlock + 宣告長度 2 bytes 但僅剩 1 byte 的 Void（0xEC 0x82 0x00）
    const badClusterPayload = concat(
      tcEl,
      cleanSimpleBlock,
      new Uint8Array([0xec, 0x82, 0x00]),
    );
    const badCluster = ebmlEl([0x1f, 0x43, 0xb6, 0x75], badClusterPayload);

    let cues = makeCue(0);
    let targetPos = tracks.length + cues.length + cleanCluster.length;
    cues = makeCue(targetPos);
    targetPos = tracks.length + cues.length + cleanCluster.length;
    cues = makeCue(targetPos);

    const blob = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        cues,
        cleanCluster,
        badCluster,
        pad45MB,
      ],
      { type: "video/x-matroska" },
    );
    const insp = await inspectHevcProfile(blob);
    expect(insp?.container).toBe("mkv");
    expect(await buildZeroCopyHevcProfileFix(blob, insp!)).toEqual({
      ok: false,
      reason: "mkv-probe-unreadable",
    });

    // 對照組：相同 Cluster 改為合法 1-byte Void（0xEC 0x81 0x00）時應正常通過修補
    const okCluster = ebmlEl(
      [0x1f, 0x43, 0xb6, 0x75],
      concat(tcEl, cleanSimpleBlock, new Uint8Array([0xec, 0x81, 0x00])),
    );
    const okBlob = new Blob(
      [
        ebmlHeader,
        segHdrUnknown,
        tracks,
        cues,
        cleanCluster,
        okCluster,
        pad45MB,
      ],
      { type: "video/x-matroska" },
    );
    const okInsp = await inspectHevcProfile(okBlob);
    expect(okInsp?.info.mismatchMain10On8Bit).toBe(true);
    const okFixed = await buildZeroCopyHevcProfileFix(okBlob, okInsp!);
    expect(okFixed.ok).toBe(true);
  });
});
