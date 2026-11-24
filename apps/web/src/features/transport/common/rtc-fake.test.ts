import { describe, expect, it, vi } from "vitest";
import type { RtcIceCandidate } from "./rtc";
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
  it("createOffer records options but keeps signalingState stable", async () => {
    const pc = new FakeRtcPeerConnection({});
    const offer = await pc.createOffer({ iceRestart: true });
    expect(offer.type).toBe("offer");
    expect(pc.signalingState).toBe("stable");
    expect(pc.offerOptions).toEqual([{ iceRestart: true }]);
  });

  it("notifies signaling changes only when a description changes the state", async () => {
    const pc = new FakeRtcPeerConnection({});
    const states: RTCSignalingState[] = [];
    pc.onsignalingstatechange = () => states.push(pc.signalingState);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await pc.setLocalDescription(offer);
    await pc.setRemoteDescription({ type: "answer", sdp: "y" });
    expect(states).toEqual(["have-local-offer", "stable"]);
  });

  it("requires a pending remote offer to create an answer", async () => {
    const pc = new FakeRtcPeerConnection({});
    const invalidState = { name: "InvalidStateError" };
    await expect(pc.createAnswer()).rejects.toMatchObject(invalidState);
    await pc.setRemoteDescription({ type: "offer", sdp: "v=0\r\n" });
    const answer = await pc.createAnswer();
    expect(pc.signalingState).toBe("have-remote-offer");
    await pc.setLocalDescription(answer);
    await expect(pc.createAnswer()).rejects.toMatchObject(invalidState);
  });

  it("implicitly creates a local offer or answer for the current state", async () => {
    const host = new FakeRtcPeerConnection({});
    const viewer = new FakeRtcPeerConnection({});
    const states: RTCSignalingState[] = [];
    viewer.onsignalingstatechange = () => states.push(viewer.signalingState);
    host.addTransceiver("video", { direction: "sendonly" });
    await host.setLocalDescription();
    await host.setLocalDescription();
    expect(host.signalingState).toBe("have-local-offer");
    const offer = host.localDescription;
    expect(offer?.type).toBe("offer");
    expect(offer?.sdp).toContain("m=video ");
    await viewer.setRemoteDescription(offer!);
    expect(viewer.getTransceivers().map((t) => t.kind)).toEqual(["video"]);
    await viewer.setLocalDescription();
    const answer = viewer.localDescription;
    expect(answer?.type).toBe("answer");
    expect(answer?.sdp).toContain("m=video ");
    await host.setRemoteDescription(answer!);
    expect([host.signalingState, viewer.signalingState]).toEqual([
      "stable",
      "stable",
    ]);
    expect(states).toEqual(["have-remote-offer", "stable"]);
  });

  it("rejects negotiation and ICE operations after an idempotent close", async () => {
    const pc = new FakeRtcPeerConnection({});
    const offer = await pc.createOffer();
    await pc.setRemoteDescription(offer);
    pc.close();
    pc.close();
    expect(pc.signalingState).toBe("closed");
    const invalidState = { name: "InvalidStateError" };
    expect(() => pc.addTransceiver("audio")).toThrow(
      expect.objectContaining(invalidState),
    );
    await expect(pc.createOffer()).rejects.toMatchObject(invalidState);
    await expect(pc.createAnswer()).rejects.toMatchObject(invalidState);
    await expect(pc.setLocalDescription()).rejects.toMatchObject(invalidState);
    await expect(pc.setRemoteDescription(offer)).rejects.toMatchObject(
      invalidState,
    );
    await expect(pc.addIceCandidate(null)).rejects.toMatchObject(invalidState);
    expect(pc.getTransceivers()).toEqual([]);
    await expect(pc.getStats()).resolves.toEqual(new Map());
  });

  it("rejects addIceCandidate before remote description and records end marker", async () => {
    const pc = new FakeRtcPeerConnection({});
    await expect(
      pc.addIceCandidate({ candidate: "candidate:1" }),
    ).rejects.toThrow();

    await pc.setRemoteDescription({ type: "offer", sdp: "x" });
    await pc.addIceCandidate({
      candidate: "candidate:1",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    await pc.addIceCandidate(null);

    expect(pc.iceCandidates).toEqual([
      { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    ]);
    expect(pc.endOfCandidates).toBe(true);
  });

  it("fires ice candidates to the handler", () => {
    const pc = new FakeRtcPeerConnection({});
    const seen: (RtcIceCandidate | null)[] = [];
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

  it("receives tracks on the transceivers created by the remote media sections", async () => {
    const pc = new FakeRtcPeerConnection({});
    const offer = {
      type: "offer" as const,
      sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
    };
    await pc.setRemoteDescription(offer);
    const [audio, video] = pc.getTransceivers();
    expect(pc.getTransceivers().map((t) => t.kind)).toEqual(["audio", "video"]);
    expect([audio?.init?.direction, video?.init?.direction]).toEqual([
      "recvonly",
      "recvonly",
    ]);
    expect([audio?.sender.track, video?.sender.track]).toEqual([null, null]);
    const onTrack = vi.fn();
    pc.ontrack = onTrack;

    const videoTrack = fakeTrack("video");
    const audioTrack = fakeTrack("audio");
    pc.fireTrack(videoTrack);
    pc.fireTrack(audioTrack);
    expect(video?.receiver.track).toBe(videoTrack);
    expect(audio?.receiver.track).toBe(audioTrack);
    expect(onTrack.mock.calls).toEqual([
      [{ track: videoTrack, streams: [], transceiver: video }],
      [{ track: audioTrack, streams: [], transceiver: audio }],
    ]);

    await pc.setLocalDescription();
    await pc.setRemoteDescription(offer);
    expect(pc.getTransceivers()).toEqual([audio, video]);
  });

  it("keeps gathered candidates in their local media sections for a single HTTP offer", async () => {
    const pc = new FakeRtcPeerConnection({});
    pc.addTransceiver("video");
    pc.addTransceiver("audio");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const done = pc.waitForIceGatheringComplete(1000);
    pc.fireIceCandidate({ candidate: "candidate:video", sdpMLineIndex: 0 });
    pc.fireIceCandidate({ candidate: "candidate:audio", sdpMid: "1" });
    pc.fireIceCandidate(null);
    await done;
    expect(pc.iceGatheringState).toBe("complete");
    const [, video, audio] = pc.localDescription!.sdp.split(/\r?\n(?=m=)/);
    expect(video).toContain("a=candidate:video");
    expect(video).not.toContain("a=candidate:audio");
    expect(audio).toContain("a=candidate:audio");
    expect(offer.sdp).not.toContain("a=candidate:");
  });

  it("exposes only the local candidates gathered before a deadline", async () => {
    vi.useFakeTimers();
    try {
      const pc = new FakeRtcPeerConnection({});
      pc.addTransceiver("video");
      await pc.setLocalDescription();
      await pc.setRemoteDescription({ type: "answer", sdp: "v=0\r\n" });
      await pc.addIceCandidate({ candidate: "candidate:remote", sdpMid: "0" });
      const done = pc.waitForIceGatheringComplete(100);
      pc.fireIceCandidate({ candidate: "candidate:local", sdpMid: "0" });
      await vi.advanceTimersByTimeAsync(100);
      await done;
      expect(pc.iceGatheringState).toBe("gathering");
      expect(pc.localDescription?.sdp).toContain("a=candidate:local");
      expect(pc.localDescription?.sdp).not.toContain("a=candidate:remote");
    } finally {
      vi.useRealTimers();
    }
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
