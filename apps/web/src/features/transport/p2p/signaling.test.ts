import { expect, it, vi } from "vitest";
import type { SignalData } from "@project/shared";
import { FakeRtcPeerConnection } from "../common/rtc-fake";
import {
  answerHost,
  deferred,
  flush,
  makeHost,
  makeViewer,
  sdp,
  track,
  useRtcFakes,
} from "./test-fixtures";

useRtcFakes();

it("negotiates two endpoints, publishes SDP before trickle ICE and samples both directions every two seconds", async () => {
  const h = makeHost();
  const v = makeViewer();
  const peerState = vi.fn(),
    state = vi.fn(),
    hostStats = vi.fn(),
    viewerStats = vi.fn(),
    errors = vi.fn();
  h.host.onPeerState(peerState);
  h.host.onStats(hostStats);
  v.viewer.onState(state);
  v.viewer.onStats(viewerStats);
  h.host.onError(errors);
  v.viewer.onError(errors);
  h.signal.sendSignal.mockImplementation((_, data) => {
    v.signal.deliver("host", data);
    return true;
  });
  v.signal.sendSignal.mockImplementation((_, data) => {
    h.signal.deliver("viewer", data);
    return true;
  });
  const setLocal = FakeRtcPeerConnection.prototype.setLocalDescription;
  vi.spyOn(
    FakeRtcPeerConnection.prototype,
    "setLocalDescription",
  ).mockImplementation(async function (
    this: FakeRtcPeerConnection,
    description,
  ) {
    await setLocal.call(this, description);
    this.fireIceCandidate({ candidate: "candidate:local", sdpMid: "0" });
    this.fireIceCandidate(null);
  });

  await h.host.start();
  await v.viewer.start();
  expect([h.connections.length, v.connections.length]).toEqual([0, 0]);
  h.signal.request();
  await flush();
  const hostPc = h.connections[0]!,
    viewerPc = v.connections[0]!;
  const { negotiationId } = h.signal.description("offer");
  for (const [endpoint, first] of [
    [h, "offer"],
    [v, "answer"],
  ] as const) {
    expect(
      endpoint.signal.sendSignal.mock.calls.map(([, data]) => [
        data.type,
        data.negotiationId,
      ]),
    ).toEqual([
      [first, negotiationId],
      ["ice", negotiationId],
      ["ice", negotiationId],
    ]);
  }
  for (const pc of [hostPc, viewerPc]) {
    expect(pc.signalingState).toBe("stable");
    expect(pc.iceCandidateHistory).toEqual([
      { candidate: "candidate:local", sdpMid: "0" },
      null,
    ]);
    pc.setIceConnectionState("connected");
    pc.setConnectionState("connected");
  }
  expect(peerState.mock.calls.flat()).toEqual([
    { memberId: "viewer", state: "connecting" },
    { memberId: "viewer", state: "playing" },
  ]);
  expect(state.mock.calls.flat()).toEqual(["connecting", "playing"]);
  const video = track("video"),
    audio = track("audio");
  viewerPc.fireTrack(video);
  viewerPc.fireTrack(audio);
  expect(v.viewer.remoteStream.getTracks()).toEqual([video, audio]);

  const report = (sent: number, received: number) =>
    new Map(
      Object.entries({
        out: { id: "out", type: "outbound-rtp", bytesSent: sent },
        in: {
          id: "in",
          type: "inbound-rtp",
          bytesReceived: received,
          packetsLost: 1,
          packetsReceived: 9,
        },
        remote: {
          id: "remote",
          type: "remote-inbound-rtp",
          fractionLost: 0.25,
        },
      }),
    );
  hostPc.statsReport = viewerPc.statsReport = report(10, 100);
  await vi.advanceTimersByTimeAsync(1999);
  expect(hostStats).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  hostPc.statsReport = viewerPc.statsReport = report(2010, 1100);
  await vi.advanceTimersByTimeAsync(2000);
  expect(hostStats.mock.calls.flat()).toEqual([
    { memberId: "viewer", bitrateKbps: 0, packetLoss: 0.25 },
    { memberId: "viewer", bitrateKbps: 8, packetLoss: 0.25 },
  ]);
  expect(viewerStats.mock.calls.flat()).toEqual([
    { bitrateKbps: 0, packetLoss: 0.1 },
    { bitrateKbps: 4, packetLoss: 0.1 },
  ]);
  expect(errors).not.toHaveBeenCalled();
  h.host.destroy();
  v.viewer.destroy();
  expect(vi.getTimerCount()).toBe(0);
});

it("drops the old answer, ICE and null before touching RTC on a restarted broadcast over the same signal", async () => {
  const h = makeHost(),
    v = makeViewer();
  const error = vi.fn();
  h.host.onError(error);
  await h.host.start();
  await v.viewer.start();
  async function exchange() {
    h.signal.request();
    await flush();
    v.signal.deliver("host", h.signal.description("offer"));
    await flush();
    return v.signal.description("answer");
  }
  const a = await exchange();
  h.host.stop();
  v.viewer.stop();
  await h.host.start();
  await v.viewer.start();
  const b = await exchange();
  expect(a.negotiationId).not.toBe(b.negotiationId);
  expect(h.connections[0]!.closed).toBe(true);
  const pc = h.connections[1]!;
  const remote = vi.spyOn(pc, "setRemoteDescription"),
    add = vi.spyOn(pc, "addIceCandidate");
  h.signal.deliver("viewer", a);
  for (const candidate of [{ candidate: "candidate:late" }, null]) {
    h.signal.deliver("viewer", {
      type: "ice",
      negotiationId: a.negotiationId,
      candidate,
    });
  }
  h.signal.deliver("other", b);
  h.signal.deliver("other", {
    type: "ice",
    negotiationId: b.negotiationId,
    candidate: null,
  });
  await flush();
  expect(pc.signalingState).toBe("have-local-offer");
  expect(remote).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  h.signal.deliver("viewer", b);
  h.signal.deliver("viewer", b);
  await flush();
  expect(remote).toHaveBeenCalledExactlyOnceWith({
    type: "answer",
    sdp: b.sdp,
  });
  expect(pc.signalingState).toBe("stable");
  expect(add).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it("queues ICE per member until its remote SDP succeeds, then drains in order with media-specific ufrag checks", async () => {
  const h = makeHost();
  await h.host.start();
  h.signal.request("one");
  h.signal.request("two");
  await flush();
  const [one, two] = h.connections as [
    FakeRtcPeerConnection,
    FakeRtcPeerConnection,
  ];
  const offer = h.signal.description("offer", "one");
  const gate = deferred<void>();
  const remote = one.setRemoteDescription.bind(one);
  vi.spyOn(one, "setRemoteDescription").mockImplementation(
    async (description) => {
      await gate.promise;
      await remote(description);
    },
  );
  const add = vi.spyOn(one, "addIceCandidate");
  const ice = (candidate: Extract<SignalData, { type: "ice" }>["candidate"]) =>
    h.signal.deliver("one", {
      type: "ice",
      negotiationId: offer.negotiationId,
      candidate,
    });
  const video = {
    candidate: "candidate:video",
    sdpMid: "vid",
    usernameFragment: "remote",
  };
  const audio = {
    candidate: "candidate:audio",
    sdpMLineIndex: 1,
    usernameFragment: "audio",
  };
  ice(video);
  answerHost(h.signal, "one");
  ice({ ...video, sdpMid: "sound" });
  ice(audio);
  ice(null);
  answerHost(h.signal, "two");
  await flush();
  expect(two.signalingState).toBe("stable");
  expect(add).not.toHaveBeenCalled();
  const adding = deferred<void>();
  add.mockImplementationOnce(async (candidate) => {
    await adding.promise;
    await FakeRtcPeerConnection.prototype.addIceCandidate.call(one, candidate);
  });
  gate.resolve();
  await flush();
  expect(add.mock.calls.flat()).toEqual([video]);
  adding.resolve();
  await flush();
  expect(one.iceCandidateHistory).toEqual([video, audio, null]);
  expect(two.iceCandidateHistory).toEqual([]);
});

it("registers the viewer's offer before fetching ICE and rejects other senders and retired credentials", async () => {
  const v = makeViewer(),
    gate = deferred<RTCIceServer[]>();
  v.fetchIceServers.mockReturnValueOnce(gate.promise);
  const signalIce = (from: string, negotiationId: string, label: string) =>
    v.signal.deliver(from, {
      type: "ice",
      negotiationId,
      candidate: {
        candidate: label,
        usernameFragment: "remote",
        sdpMid: "vid",
      },
    });
  await v.viewer.start();
  signalIce("host", "A", "before-offer");
  v.signal.deliver("host", { type: "offer", negotiationId: "A", sdp: sdp() });
  signalIce("host", "A", "early");
  signalIce("other", "A", "wrong-member");
  signalIce("host", "old", "wrong-id");
  gate.resolve([]);
  await flush();
  const pc = v.connections[0]!;
  expect(
    pc.iceCandidateHistory.map((candidate) => candidate?.candidate),
  ).toEqual(["early"]);
  const oldRemote = pc.setRemoteDescription.bind(pc),
    wait = deferred<void>();
  vi.spyOn(pc, "setRemoteDescription").mockImplementation(
    async (description) => {
      await wait.promise;
      await oldRemote(description);
    },
  );
  v.signal.deliver("host", {
    type: "offer",
    negotiationId: "B",
    sdp: sdp("100", "new"),
  });
  signalIce("host", "B", "wrong-fragment");
  const next = {
    candidate: "candidate:next",
    sdpMid: "vid",
    usernameFragment: "new",
  };
  v.signal.deliver("host", {
    type: "ice",
    negotiationId: "B",
    candidate: next,
  });
  v.signal.deliver("host", {
    type: "ice",
    negotiationId: "A",
    candidate: null,
  });
  v.signal.deliver("host", {
    type: "ice",
    negotiationId: "B",
    candidate: null,
  });
  expect(pc.iceCandidateHistory).toHaveLength(1);
  wait.resolve();
  await flush();
  expect(pc.iceCandidateHistory.slice(1)).toEqual([next, null]);
  expect(v.signal.description("answer").negotiationId).toBe("B");
});

it.each([true, false])(
  "labels local restart ICE only when attributable (previous gathering ended: %s)",
  async (ended) => {
    const h = makeHost();
    await h.host.start();
    h.signal.request();
    await flush();
    const pc = h.connections[0]!;
    const a = h.signal.description("offer");
    const fragment = (sdp: string) => /^a=ice-ufrag:(\S+)/m.exec(sdp)![1]!;
    if (ended) pc.fireIceCandidate(null);
    answerHost(h.signal);
    await flush();
    pc.setIceConnectionState("failed");
    await flush();
    const b = h.signal.description("offer");
    const active = {
      candidate: "candidate:new",
      usernameFragment: fragment(b.sdp),
      sdpMid: "0",
    };
    const anonymous = { candidate: "candidate:no-fragment", sdpMid: "0" };
    pc.fireIceCandidate({
      candidate: "candidate:old",
      usernameFragment: fragment(a.sdp),
      sdpMid: "0",
    });
    pc.fireIceCandidate(active);
    pc.fireIceCandidate(anonymous);
    pc.fireIceCandidate(null);
    const sent = h.signal.sendSignal.mock.calls.flatMap(([, data]) =>
      data.type === "ice" && data.negotiationId === b.negotiationId
        ? [data.candidate]
        : [],
    );
    expect(sent).toEqual(ended ? [active, anonymous, null] : [active]);
  },
);
