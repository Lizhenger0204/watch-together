/** 影音 BUNDLE 的 answer，兩段都協商了 transport-cc。 */
export const TWCC_ANSWER = [
  "v=0",
  "a=group:BUNDLE 0 1",
  "m=video 9 UDP/TLS/RTP/SAVPF 102",
  "a=mid:0",
  "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  "a=rtpmap:102 H264/90000",
  "a=rtcp-fb:102 transport-cc",
  "a=fmtp:102 packetization-mode=1;profile-level-id=42001f",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:1",
  "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");
