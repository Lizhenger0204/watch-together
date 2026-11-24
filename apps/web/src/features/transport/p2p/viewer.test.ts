import { expect, it, vi } from "vitest";
import { FakeRtcPeerConnection } from "../common/rtc-fake";
import {
  deferred,
  flush,
  makeHost,
  makeViewer,
  sdp,
  track,
  useRtcFakes,
} from "./test-fixtures";

useRtcFakes();

it("retains the receiver tracks and stream through an ICE restart with no second track event", async () => {
  const v = makeViewer(),
    states = vi.fn(),
    stream = v.viewer.remoteStream;
  v.viewer.onState(states);
  await v.viewer.start();
  v.signal.deliver("host", { type: "offer", negotiationId: "A", sdp: sdp() });
  await flush();
  const pc = v.connections[0]!,
    video = track("video"),
    audio = track("audio");
  pc.fireTrack(video);
  pc.fireTrack(audio);
  pc.setIceConnectionState("connected");
  pc.setIceConnectionState("disconnected");
  const restarted = sdp("100", "restarted").replace("100 1 IN", "100 2 IN");
  v.signal.deliver("host", {
    type: "offer",
    negotiationId: "B",
    sdp: restarted,
  });
  await flush();
  pc.setIceConnectionState("completed");
  expect(v.signal.description("answer").negotiationId).toBe("B");
  expect(v.connections).toHaveLength(1);
  expect(v.fetchIceServers).toHaveBeenCalledTimes(1);
  expect(stream.getTracks()).toEqual([video, audio]);
  expect(v.viewer.remoteStream).toBe(stream);
  expect(states.mock.calls.flat()).toEqual([
    "connecting",
    "playing",
    "connecting",
    "playing",
  ]);
  v.viewer.stop();
  v.viewer.stop();
  expect(states).toHaveBeenLastCalledWith("waiting");
  expect(stream.getTracks()).toEqual([]);
  expect(pc.closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces the PC for a new SDP session and ignores late track, ICE, state and stats callbacks on its predecessor", async () => {
  const v = makeViewer(),
    stats = vi.fn(),
    states = vi.fn(),
    error = vi.fn(),
    stream = v.viewer.remoteStream;
  v.viewer.onStats(stats);
  v.viewer.onState(states);
  v.viewer.onError(error);
  await v.viewer.start();
  v.signal.deliver("host", { type: "offer", negotiationId: "A", sdp: sdp() });
  await flush();
  const a = v.connections[0]!,
    oldTrack = track("video");
  a.fireTrack(oldTrack);
  a.setIceConnectionState("connected");
  const sample = deferred<RTCStatsReport>();
  vi.spyOn(a, "getStats").mockReturnValueOnce(sample.promise);
  await vi.advanceTimersByTimeAsync(2000);
  const onTrack = a.ontrack!,
    onIce = a.onicecandidate!,
    onState = a.oniceconnectionstatechange!;
  v.signal.deliver("host", {
    type: "offer",
    negotiationId: "B",
    sdp: sdp("200", "other"),
  });
  expect(stream.getTracks()).toEqual([]);
  await flush();
  expect(a.closed).toBe(true);
  expect(v.fetchIceServers).toHaveBeenCalledTimes(2);
  const b = v.connections[1]!,
    next = track("video");
  b.fireTrack(next);
  onTrack({
    track: oldTrack,
    streams: [],
    transceiver: a.getTransceivers()[0]!,
  });
  onIce({ candidate: null });
  onState();
  sample.resolve(new Map() as RTCStatsReport);
  await flush();
  expect(stats).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(stream.getTracks()).toEqual([next]);
  expect(v.signal.sendSignal.mock.calls.map(([, data]) => data.type)).toEqual([
    "answer",
    "answer",
  ]);
  b.setIceConnectionState("connected");
  expect(states.mock.calls.flat()).toEqual([
    "connecting",
    "playing",
    "connecting",
    "playing",
  ]);
});

it("starts without a first-offer timer and accepts a fresh offer after room-driven teardown and reauthentication", async () => {
  const old = makeViewer(),
    states = vi.fn(),
    errors = vi.fn();
  old.viewer.onState(states);
  old.viewer.onError(errors);
  await old.viewer.start();
  await old.viewer.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  expect(states.mock.calls.flat()).toEqual(["connecting"]);
  expect(errors).not.toHaveBeenCalled();
  old.viewer.destroy();
  old.viewer.destroy();
  const fresh = makeViewer();
  await fresh.viewer.start();
  const offer = { type: "offer", negotiationId: "fresh", sdp: sdp() } as const;
  old.signal.deliver("host", offer);
  fresh.signal.deliver("host", offer);
  await flush();
  expect(old.connections).toHaveLength(0);
  expect(fresh.signal.description("answer").negotiationId).toBe("fresh");
  expect(old.signal.sendSignal).not.toHaveBeenCalled();
  await expect(old.viewer.start()).rejects.toThrow();
});

it("supersedes an offer during ICE fetch and continues with the latest signal while the first fetch is still pending", async () => {
  const v = makeViewer(),
    gate = deferred<RTCIceServer[]>(),
    error = vi.fn();
  v.viewer.onError(error);
  v.fetchIceServers.mockReturnValueOnce(gate.promise);
  await v.viewer.start();
  v.signal.deliver("host", { type: "offer", negotiationId: "A", sdp: sdp() });
  v.signal.deliver("host", {
    type: "ice",
    negotiationId: "A",
    candidate: null,
  });
  v.signal.deliver("host", {
    type: "offer",
    negotiationId: "B",
    sdp: sdp("200"),
  });
  await flush();
  expect(v.connections).toHaveLength(1);
  expect(v.signal.description("answer").negotiationId).toBe("B");
  gate.reject(new Error());
  await flush();
  expect(v.connections[0]!.endOfCandidates).toBe(false);
  expect(v.signal.sendSignal).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
});

it("drops pending SDP and queued ICE when an in-flight offer is superseded or the viewer is destroyed", async () => {
  const v = makeViewer(),
    errors = vi.fn(),
    states = vi.fn();
  v.viewer.onError(errors);
  v.viewer.onState(states);
  const gates = [deferred<void>(), deferred<void>()];
  const remote = vi
    .spyOn(FakeRtcPeerConnection.prototype, "setRemoteDescription")
    .mockReturnValueOnce(gates[0]!.promise)
    .mockReturnValueOnce(gates[1]!.promise);
  const answer = vi.spyOn(FakeRtcPeerConnection.prototype, "createAnswer"),
    add = vi.spyOn(FakeRtcPeerConnection.prototype, "addIceCandidate");
  await v.viewer.start();
  for (const negotiationId of ["A", "B"]) {
    v.signal.deliver("host", { type: "offer", negotiationId, sdp: sdp() });
    v.signal.deliver("host", { type: "ice", negotiationId, candidate: null });
    await flush();
  }
  expect(remote).toHaveBeenCalledTimes(2);
  gates[0]!.resolve();
  await flush();
  v.viewer.destroy();
  v.viewer.stop();
  gates[1]!.reject(new Error());
  await vi.advanceTimersByTimeAsync(20000);
  expect(answer).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  expect(states.mock.calls.flat()).toEqual(["connecting"]);
  expect(v.signal.sendSignal).not.toHaveBeenCalled();
  expect(v.connections.every((pc) => pc.closed)).toBe(true);
});

it.each(["ICE_UNAVAILABLE", "SIGNAL_ERROR"] as const)(
  "surfaces %s at both ends with member scope only on the host",
  async (code) => {
    const h = makeHost(),
      v = makeViewer(),
      hError = vi.fn(),
      vError = vi.fn(),
      state = vi.fn();
    h.host.onError(hError);
    v.viewer.onError(vError);
    v.viewer.onState(state);
    for (const endpoint of [h, v]) {
      if (code === "SIGNAL_ERROR")
        endpoint.signal.sendSignal.mockReturnValue(false);
      else endpoint.fetchIceServers.mockRejectedValue(new Error());
    }
    await h.host.start();
    await v.viewer.start();
    h.signal.request();
    v.signal.deliver("host", { type: "offer", negotiationId: "A", sdp: sdp() });
    await flush();
    expect(hError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code, memberId: "viewer" }),
    );
    expect(vError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code, memberId: undefined }),
    );
    expect(state.mock.calls.flat()).toEqual(["connecting", "failed"]);
    expect(vi.getTimerCount()).toBe(0);
  },
);
