import { expect, it, vi } from "vitest";
import { createFakePeerConnectionFactory } from "../common/rtc-fake";
import { flush, makeHost, useRtcFakes } from "./test-fixtures";

useRtcFakes();

function h264OfferSdp(ufrag: string) {
  return [
    "v=0",
    "o=- 42 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=ice-ufrag:${ufrag}`,
    "a=ice-pwd:fakeHostPasswordForCompatTest",
    "m=video 9 UDP/TLS/RTP/SAVPF 102 103 108 109 96",
    "a=mid:0",
    "a=sendonly",
    "a=rtpmap:102 H264/90000",
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
    "a=rtpmap:103 rtx/90000",
    "a=fmtp:103 apt=102",
    "a=rtpmap:108 H264/90000",
    "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    "a=rtpmap:109 rtx/90000",
    "a=fmtp:109 apt=108",
    "a=rtpmap:96 VP8/90000",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=mid:1",
    "a=sendonly",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");
}

function viewerAnswerSdp(ufrag: string, pts: "102+108" | "108-only") {
  const videoLines =
    pts === "102+108"
      ? [
          "m=video 9 UDP/TLS/RTP/SAVPF 102 103 108 109",
          "a=mid:0",
          "a=recvonly",
          "a=rtpmap:102 H264/90000",
          "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028",
          "a=rtpmap:103 rtx/90000",
          "a=fmtp:103 apt=102",
          "a=rtpmap:108 H264/90000",
          "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
          "a=rtpmap:109 rtx/90000",
          "a=fmtp:109 apt=108",
        ]
      : [
          "m=video 9 UDP/TLS/RTP/SAVPF 108 109",
          "a=mid:0",
          "a=recvonly",
          "a=rtpmap:108 H264/90000",
          "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
          "a=rtpmap:109 rtx/90000",
          "a=fmtp:109 apt=108",
        ];
  return [
    "v=0",
    "o=- 99 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=ice-ufrag:${ufrag}`,
    "a=ice-pwd:fakeViewerPasswordForCompatTest",
    ...videoLines,
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=mid:1",
    "a=recvonly",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");
}

function makeH264Host() {
  const { factory, connections } = createFakePeerConnectionFactory();
  let offerSeq = 0;
  const h = makeHost(undefined, {
    createPeerConnection: (config) => {
      const pc = factory(config);
      vi.spyOn(pc, "createOffer").mockImplementation(async () => ({
        type: "offer",
        sdp: h264OfferSdp(`host${++offerSeq}`),
      }));
      return pc;
    },
  });
  return { ...h, connections };
}

it("maps 42001f to 42e01f on wire offers, keeps local 42001f, and restores answers including ICE restarts", async () => {
  const h = makeH264Host();
  await h.host.start();
  h.signal.request("safari");
  await flush();

  const pc = h.connections[0]!;
  // 房主本機 localDescription 保留原始 42001f（走硬體編碼路徑）。
  expect(pc.localDescription?.sdp).toContain(
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
  );
  // 送出信令的 offer 把 PT 102 映射為 42e01f，PT 108 維持原樣。
  const firstOffer = h.signal.description("offer", "safari");
  expect(firstOffer.sdp).toContain(
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  );
  expect(firstOffer.sdp).toContain(
    "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  );

  // 收看端以 PT 102（42e028）+ PT 108（42e01f）回應：房主端只把 PT 102 還原為 420028。
  h.signal.deliver("safari", {
    type: "answer",
    negotiationId: firstOffer.negotiationId,
    sdp: viewerAnswerSdp("viewer1", "102+108"),
  });
  await flush();
  expect(pc.remoteDescription?.sdp).toContain(
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=420028",
  );
  expect(pc.remoteDescription?.sdp).toContain(
    "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  );

  // 觸發 ICE restart：新協商代次一樣映射 offer 並還原 answer。
  pc.setIceConnectionState("connected");
  pc.setIceConnectionState("failed");
  await flush();
  pc.setIceConnectionState("checking");
  const restartOffer = h.signal.description("offer", "safari");
  expect(restartOffer.negotiationId).not.toBe(firstOffer.negotiationId);
  expect(restartOffer.sdp).toContain(
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  );
  h.signal.deliver("safari", {
    type: "answer",
    negotiationId: restartOffer.negotiationId,
    sdp: viewerAnswerSdp("viewer2", "102+108"),
  });
  await flush();
  expect(pc.remoteDescription?.sdp).toContain(
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=420028",
  );
  expect(pc.signalingState).toBe("stable");
});

it("does not alter native 42e01f when a viewer rejects the mapped PT and falls back to PT 108", async () => {
  const h = makeH264Host();
  await h.host.start();
  h.signal.request("fallback");
  await flush();

  const pc = h.connections[0]!;
  const offer = h.signal.description("offer", "fallback");
  const fallbackAnswer = viewerAnswerSdp("viewer-fb", "108-only");
  h.signal.deliver("fallback", {
    type: "answer",
    negotiationId: offer.negotiationId,
    sdp: fallbackAnswer,
  });
  await flush();
  expect(pc.remoteDescription?.sdp).toBe(fallbackAnswer);
});
