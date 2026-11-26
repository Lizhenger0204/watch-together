/**
 * 房主本機套用對端 answer 前的頻寬調整（streaming.md §2「頻寬估計」，T-139）。
 * 只改房主自己 `setRemoteDescription` 的字串，不送給任何人。
 *
 * 音訊不參與 transport-cc：拿掉 audio m-section 的 `a=rtcp-fb:* transport-cc` 與
 * transport-wide-cc 標頭擴充。實測（ADR 0005）影音同在一條 BUNDLE 連線、音訊也帶
 * transport-cc 時，Chrome 的頻寬估計約每 5 秒下降 15～25%，4K／25 Mbps 約 45 秒才到；
 * 拿掉後平滑爬升（約 31 秒）。video 段不動。
 */
export function withoutAudioTransportCc(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp
    .split(/(?=\r?\nm=)/)
    .map((section) => {
      const lead = /^\r?\n/.exec(section)?.[0] ?? "";
      const body = section.slice(lead.length);
      if (!body.startsWith("m=audio ")) return section;
      const lines = body
        .split(/\r?\n/)
        .filter(
          (line) =>
            !/^a=rtcp-fb:\S+ transport-cc\s*$/i.test(line) &&
            !/^a=extmap:\S+ \S*transport-wide-cc/i.test(line),
        );
      return lead + lines.join(eol);
    })
    .join("");
}
