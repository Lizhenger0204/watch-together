/**
 * P2P 跨瀏覽器 H.264 Baseline ↔ Constrained Baseline SDP 相容映射（streaming.md §3，T-139）。
 *
 * macOS Chrome 的硬體編碼器 VideoToolbox 只宣告 Baseline（4200xx）／Main（4d00xx）／
 * High（6400xx），Constrained Baseline（42e0xx）會退回軟體 OpenH264；而 Safari／WebKit
 * 接收端只宣告 640cxx 與 42e0xx。WebRTC 的 H.264 Baseline 編碼不輸出 B-frame／FMO／ASO，
 * bitstream 與 Constrained Baseline 相容。
 *
 * 房主本機 `setLocalDescription(offer)` 保持原樣；送出信令前，若 video 區段首個 H.264 PT
 * 為 `packetization-mode=1` 的 `4200LL`，僅將該 PT 的 `profile-level-id` 映射成 `42e0LL`；
 * 收到同協商代次的 answer 後，於 `setRemoteDescription(answer)` 前，僅將該 PT 還原為 `4200YY`
 * （保留對端回傳的 level `YY`），其餘 PT（含原生 `42e01f` 備援或 VP8）完全不動。
 */

const H264_RTPMAP = /^a=rtpmap:(\d+)\s+h264\/\d+(?:\/\d+)?\s*$/i;
const PACKETIZATION_MODE_1 = /(?:^|[;\s])packetization-mode=1(?:;|\s|$)/i;
const BASELINE_PROFILE_LEVEL =
  /(^|[;\s])(profile-level-id=42)00([0-9a-f]{2})(?=[;\s]|$)/i;
const CONSTRAINED_BASELINE_PROFILE_LEVEL =
  /(^|[;\s])(profile-level-id=42)e0([0-9a-f]{2})(?=[;\s]|$)/i;

export interface MappedH264Offer {
  /** 要透過信令送給收看者的 offer SDP（無符合的 PT 時為原字串）。 */
  readonly sdp: string;
  /** 被映射的 video H.264 payload type；沒有映射時為 null。 */
  readonly mappedPt: string | null;
}

function splitSections(sdp: string): string[] {
  return sdp.split(/(?=\r?\nm=)/);
}

function eolOf(sdp: string): "\r\n" | "\n" {
  return sdp.includes("\r\n") ? "\r\n" : "\n";
}

function splitLeadingNewline(section: string): {
  prefix: string;
  body: string;
} {
  const match = /^(\r?\n)/.exec(section);
  if (!match) return { prefix: "", body: section };
  return { prefix: match[1]!, body: section.slice(match[1]!.length) };
}

/**
 * 檢查 video 區段首個 H.264 payload type：若為 `packetization-mode=1` 且
 * `profile-level-id=4200LL`，只改寫該 PT 的 `a=fmtp` 為 `42e0LL`。
 */
export function mapH264BaselineOffer(sdp: string): MappedH264Offer {
  const eol = eolOf(sdp);
  const sections = splitSections(sdp);
  let mappedPt: string | null = null;

  const rewritten = sections.map((section) => {
    if (mappedPt !== null) return section;
    const { prefix, body } = splitLeadingNewline(section);
    if (!body.startsWith("m=video ")) return section;

    const lines = body.split(/\r?\n/);
    const pts = (lines[0] ?? "").trim().split(/\s+/).slice(3);
    const h264Pts = new Set<string>();
    for (const line of lines) {
      const match = H264_RTPMAP.exec(line);
      if (match) h264Pts.add(match[1]!);
    }

    const firstH264Pt = pts.find((pt) => h264Pts.has(pt));
    if (!firstH264Pt) return section;

    const fmtpPrefix = `a=fmtp:${firstH264Pt} `;
    const fmtpIndex = lines.findIndex((line) => line.startsWith(fmtpPrefix));
    if (fmtpIndex < 0) return section;

    const params = lines[fmtpIndex]!.slice(fmtpPrefix.length);
    if (!PACKETIZATION_MODE_1.test(params)) return section;
    if (!BASELINE_PROFILE_LEVEL.test(params)) return section;

    mappedPt = firstH264Pt;
    lines[fmtpIndex] =
      fmtpPrefix + params.replace(BASELINE_PROFILE_LEVEL, "$1$2e0$3");
    return prefix + lines.join(eol);
  });

  return {
    sdp: mappedPt === null ? sdp : rewritten.join(""),
    mappedPt,
  };
}

/**
 * 收到收看者 answer 時，只針對先前記錄的 `mappedPt`，把 video 區段內該 PT 的
 * `profile-level-id=42e0YY` 還原為 `4200YY`（保留對端回傳的 level `YY`）。
 */
export function restoreH264BaselineAnswer(
  sdp: string,
  mappedPt: string | null,
): string {
  if (mappedPt === null) return sdp;
  const eol = eolOf(sdp);
  const fmtpPrefix = `a=fmtp:${mappedPt} `;
  let changed = false;

  const rewritten = splitSections(sdp).map((section) => {
    const { prefix, body } = splitLeadingNewline(section);
    if (!body.startsWith("m=video ")) return section;

    const lines = body.split(/\r?\n/);
    const fmtpIndex = lines.findIndex((line) => line.startsWith(fmtpPrefix));
    if (fmtpIndex < 0) return section;

    const params = lines[fmtpIndex]!.slice(fmtpPrefix.length);
    if (!CONSTRAINED_BASELINE_PROFILE_LEVEL.test(params)) return section;

    changed = true;
    lines[fmtpIndex] =
      fmtpPrefix +
      params.replace(CONSTRAINED_BASELINE_PROFILE_LEVEL, "$1$200$3");
    return prefix + lines.join(eol);
  });

  return changed ? rewritten.join("") : sdp;
}
