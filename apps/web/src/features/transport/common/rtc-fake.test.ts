import { describe, expect, it } from "vitest";
import {
  createFakePeerConnectionFactory,
  FakeRtcPeerConnection,
  FakeRtcRtpSender,
} from "./rtc-fake";

function fakeTrack(
  kind: "audio" | "video",
  id = `${kind}-1`,
): MediaStreamTrack {
  return { kind, id } as MediaStreamTrack;
}

describe("FakeRtcRtpSender", () => {
  it("records replaceTrack calls", async () => {
    const sender = new FakeRtcRtpSender(fakeTrack("video"));
    const next = fakeTrack("video", "v2");
    await sender.replaceTrack(next);
    expect(sender.replaceTrackCalls).toEqual([next]);
    expect(sender.track).toBe(next);
  });
});

describe("FakeRtcPeerConnection", () => {
  it("creates an offer and records its options", async () => {
    const pc = new FakeRtcPeerConnection({});
    const offer = await pc.createOffer({ iceRestart: true });
    expect(offer.type).toBe("offer");
    expect(pc.offerOptions).toEqual([{ iceRestart: true }]);
  });

  it("fires ice candidates to the handler", () => {
    const pc = new FakeRtcPeerConnection({});
    const seen: (RTCIceCandidateInit | null)[] = [];
    pc.onicecandidate = (event) => seen.push(event.candidate);

    pc.fireIceCandidate({
      candidate: "candidate:1",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    pc.fireIceCandidate(null);

    expect(seen).toEqual([
      { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
      null,
    ]);
  });

  it("records transceivers and codec preferences", () => {
    const pc = new FakeRtcPeerConnection({});
    const video = pc.addTransceiver(fakeTrack("video"), {
      direction: "sendonly",
    });
    const audio = pc.addTransceiver("audio", { direction: "sendonly" });

    expect(pc.getTransceivers()).toEqual([video, audio]);

    video.setCodecPreferences([{ mimeType: "video/H264", clockRate: 90000 }]);
    expect(video.codecPreferences).toEqual([
      { mimeType: "video/H264", clockRate: 90000 },
    ]);
  });

  it("tracks connection state changes", () => {
    const pc = new FakeRtcPeerConnection({});
    let changed = 0;
    pc.onconnectionstatechange = () => {
      changed += 1;
    };
    pc.setConnectionState("connected");
    expect(pc.connectionState).toBe("connected");
    expect(changed).toBe(1);
  });
});

describe("createFakePeerConnectionFactory", () => {
  it("returns a factory and tracks the created connections", () => {
    const { factory, connections } = createFakePeerConnectionFactory();
    const pc = factory({});
    expect(connections).toEqual([pc]);
  });
});
