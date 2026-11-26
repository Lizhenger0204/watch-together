import { describe, expect, it } from "vitest";
import { mapH264BaselineOffer, restoreH264BaselineAnswer } from "./h264-sdp";

const CHROME_OFFER = [
  "v=0",
  "o=- 123 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=video 9 UDP/TLS/RTP/SAVPF 102 103 108 109 96 97",
  "a=rtpmap:102 H264/90000",
  "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
  "a=rtpmap:103 rtx/90000",
  "a=fmtp:103 apt=102",
  "a=rtpmap:108 H264/90000",
  "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  "a=rtpmap:109 rtx/90000",
  "a=fmtp:109 apt=108",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "",
].join("\r\n");

describe("mapH264BaselineOffer", () => {
  it("rewrites only the first video H.264 4200xx pm=1 PT to 42e0xx and preserves all other lines", () => {
    const result = mapH264BaselineOffer(CHROME_OFFER);
    expect(result.mappedPt).toBe("102");
    expect(result.sdp).toContain(
      "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n",
    );
    // 原生 42e01f PT、rtx apt 與 audio 區段皆維持不變。
    expect(result.sdp).toContain(
      "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n",
    );
    expect(result.sdp).toContain("a=fmtp:103 apt=102\r\n");
    expect(result.sdp).toContain("a=fmtp:111 minptime=10;useinbandfec=1\r\n");
    expect(result.sdp.endsWith("\r\n")).toBe(true);
  });

  it("preserves non-3.1 levels, arbitrary parameter order, and LF line endings", () => {
    const sdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 120",
      "a=rtpmap:120 h264/90000",
      "a=fmtp:120 profile-level-id=420028; packetization-mode=1",
    ].join("\n");
    const result = mapH264BaselineOffer(sdp);
    expect(result).toEqual({
      mappedPt: "120",
      sdp: [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 120",
        "a=rtpmap:120 h264/90000",
        "a=fmtp:120 profile-level-id=42e028; packetization-mode=1",
      ].join("\n"),
    });
  });

  it("does not map when the first H.264 PT is already 42e0xx, non-baseline, pm=0, or lacks fmtp", () => {
    const alreadyConstrained = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 108 102",
      "a=rtpmap:108 H264/90000",
      "a=fmtp:108 packetization-mode=1;profile-level-id=42e01f",
      "a=rtpmap:102 H264/90000",
      "a=fmtp:102 packetization-mode=1;profile-level-id=42001f",
    ].join("\r\n");
    expect(mapH264BaselineOffer(alreadyConstrained)).toEqual({
      sdp: alreadyConstrained,
      mappedPt: null,
    });

    const pm0Only = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 104",
      "a=rtpmap:104 H264/90000",
      "a=fmtp:104 packetization-mode=0;profile-level-id=42001f",
    ].join("\r\n");
    expect(mapH264BaselineOffer(pm0Only)).toEqual({
      sdp: pm0Only,
      mappedPt: null,
    });

    const mainProfile = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 116",
      "a=rtpmap:116 H264/90000",
      "a=fmtp:116 packetization-mode=1;profile-level-id=4d001f",
    ].join("\r\n");
    expect(mapH264BaselineOffer(mainProfile)).toEqual({
      sdp: mainProfile,
      mappedPt: null,
    });

    const minimalFake = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
    expect(mapH264BaselineOffer(minimalFake)).toEqual({
      sdp: minimalFake,
      mappedPt: null,
    });
  });
});

describe("restoreH264BaselineAnswer", () => {
  it("restores only the mapped video PT (preserving asymmetric answer level) and leaves native 42e0xx untouched", () => {
    const answer = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 102",
      "a=fmtp:102 profile-level-id=42e01f",
      "m=video 9 UDP/TLS/RTP/SAVPF 102 103 108 109",
      "a=rtpmap:102 H264/90000",
      "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028",
      "a=rtpmap:103 rtx/90000",
      "a=fmtp:103 apt=102",
      "a=rtpmap:108 H264/90000",
      "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      "a=rtpmap:109 rtx/90000",
      "a=fmtp:109 apt=108",
      "",
    ].join("\r\n");

    const restored = restoreH264BaselineAnswer(answer, "102");
    // video 的 PT 102 還原成 420028（保留對端 level 28）。
    expect(restored).toContain(
      "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=420028\r\n",
    );
    // 原生 42e01f 的 PT 108 與 m=audio 不被改動。
    expect(restored).toContain(
      "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n",
    );
    expect(restored).toContain(
      "m=audio 9 UDP/TLS/RTP/SAVPF 102\r\na=fmtp:102 profile-level-id=42e01f\r\n",
    );
  });

  it("returns original SDP unchanged when mappedPt is null or rejected by the viewer", () => {
    const fallbackAnswer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 108 96",
      "a=rtpmap:108 H264/90000",
      "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      "a=rtpmap:96 VP8/90000",
    ].join("\r\n");

    expect(restoreH264BaselineAnswer(fallbackAnswer, null)).toBe(
      fallbackAnswer,
    );
    expect(restoreH264BaselineAnswer(fallbackAnswer, "102")).toBe(
      fallbackAnswer,
    );
  });
});
