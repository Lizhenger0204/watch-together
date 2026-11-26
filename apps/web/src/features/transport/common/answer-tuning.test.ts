import { describe, expect, it } from "vitest";
import { withoutAudioTransportCc } from "./answer-tuning";
import { TWCC_ANSWER } from "./answer-tuning.fixtures";

describe("withoutAudioTransportCc", () => {
  it("只拿掉 audio 段的 transport-cc 回饋與標頭擴充，video 段與其他行不動", () => {
    const out = withoutAudioTransportCc(TWCC_ANSWER);
    const [video, audio] = out.split("\r\nm=audio");
    expect(video).toContain("a=rtcp-fb:102 transport-cc");
    expect(video).toContain("transport-wide-cc-extensions-01");
    expect(audio).not.toContain("transport-cc");
    expect(audio).not.toContain("transport-wide-cc");
    expect(audio).toContain(
      "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
    );
    expect(audio).toContain("a=fmtp:111 minptime=10;useinbandfec=1");
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("沒有 audio 段或已拿掉時原樣回傳", () => {
    const once = withoutAudioTransportCc(TWCC_ANSWER);
    expect(withoutAudioTransportCc(once)).toBe(once);
    const videoOnly = TWCC_ANSWER.split("\r\nm=audio")[0]! + "\r\n";
    expect(withoutAudioTransportCc(videoOnly)).toBe(videoOnly);
  });
});
