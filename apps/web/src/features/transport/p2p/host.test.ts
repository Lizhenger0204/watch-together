import { expect, it, vi } from "vitest";
import { TARGETS } from "../common/encoding.fixtures";
import { FakeRtcPeerConnection } from "../common/rtc-fake";
import {
  answerHost,
  deferred,
  flush,
  makeHost,
  sdp,
  track,
  useRtcFakes,
} from "./test-fixtures";

useRtcFakes();

async function withAnsweredPeer() {
  const h = makeHost();
  await h.host.start();
  h.signal.request();
  await flush();
  answerHost(h.signal);
  await flush();
  const pc = h.connections[0]!;
  pc.setIceConnectionState("connected");
  return { ...h, pc };
}

it("reserves both senders, applies H.264 first, and carries the latest tracks and scaled quality to late joiners", async () => {
  const video = track("video", 2160),
    stream = new MediaStream([video]);
  const h = makeHost(stream);
  await h.host.start();
  h.signal.request();
  await flush();
  const [firstVideo, firstAudio] = h.connections[0]!.getTransceivers();
  expect(firstVideo?.init?.direction).toBe("sendonly");
  expect(firstAudio?.init?.direction).toBe("sendonly");
  expect(firstVideo?.sender.track).toBe(video);
  expect(firstAudio?.sender.track).toBeNull();
  expect(firstVideo?.codecPreferences.map((c) => c.mimeType)).toEqual([
    "video/H264",
    "video/VP8",
  ]);
  expect(firstAudio?.codecPreferences.map((c) => c.mimeType)).toEqual([
    "audio/opus",
  ]);
  expect(firstAudio?.sender.getParameters().encodings[0]?.maxBitrate).toBe(
    128000,
  );
  expect(firstVideo?.sender.getParameters().encodings[0]).toMatchObject({
    scaleResolutionDownBy: 2,
    maxBitrate: 6000000,
    maxFramerate: 30,
  });
  expect(firstVideo?.sender.getParameters().degradationPreference).toBe(
    "maintain-framerate",
  );
  expect(video.contentHint).toBe("motion");
  answerHost(h.signal);
  const audio = track("audio");
  h.host.replaceTrack("audio", audio);
  h.host.replaceTrack("video", null);
  await flush();
  expect(firstAudio?.sender.track).toBe(audio);
  expect(firstVideo?.sender.track).toBeNull();
  const secondVideo = track("video", 1080);
  const gate = deferred<RTCIceServer[]>();
  h.fetchIceServers.mockReturnValueOnce(gate.promise);
  h.signal.request("late");
  h.host.replaceTrack("video", secondVideo);
  await h.host.setQuality(TARGETS.smooth);
  gate.resolve([{ urls: "stun:example.invalid" }]);
  await flush();
  expect(h.connections[0]!.offerOptions).toHaveLength(1);
  expect(h.fetchIceServers).toHaveBeenCalledTimes(2);
  for (const pc of h.connections) {
    const [v, a] = pc.getTransceivers();
    expect(a?.sender.track).toBe(audio);
    expect(v?.sender.track).toBe(secondVideo);
    expect(v?.sender.getParameters().encodings[0]).toMatchObject({
      scaleResolutionDownBy: 1.5,
      maxBitrate: 3000000,
    });
  }
  expect(h.connections[1]?.configuration.iceServers).toEqual([
    { urls: "stun:example.invalid" },
  ]);
  expect(secondVideo.contentHint).toBe("motion");
  expect(h.host.stream).toBe(stream);
  h.host.destroy();
  for (const t of [video, secondVideo, audio])
    expect(t.stop).not.toHaveBeenCalled();
});

it("reports each failing member, preserves successful quality changes and rejects with the first member's error", async () => {
  const h = makeHost(),
    errors = vi.fn();
  h.host.onError(errors);
  await h.host.start();
  for (const id of ["one", "two", "three"]) h.signal.request(id);
  await flush();
  const video = h.connections.map((pc) => pc.getTransceivers()[0]!.sender);
  vi.spyOn(video[0]!, "setParameters").mockRejectedValueOnce(new Error());
  vi.spyOn(video[2]!, "setParameters").mockRejectedValueOnce(new Error());
  const failure = await h.host
    .setQuality(TARGETS.smooth)
    .catch((e: unknown) => e);
  expect(
    errors.mock.calls.flat().map(({ code, memberId }) => [code, memberId]),
  ).toEqual([
    ["TRACK_ERROR", "one"],
    ["TRACK_ERROR", "three"],
  ]);
  expect(failure).toBe(errors.mock.calls[0]![0]);
  expect(video[1]!.getParameters().encodings[0]?.maxBitrate).toBe(3000000);
  h.signal.request("late");
  await flush();
  expect(
    h.connections[3]!.getTransceivers()[0]!.sender.getParameters().encodings[0]
      ?.maxBitrate,
  ).toBe(3000000);
});

it("serializes overlapping sender writes and finishes at the latest quality and source height", async () => {
  const h = await withAnsweredPeer(),
    video = h.pc.getTransceivers()[0]!.sender;
  const gate = deferred<void>(),
    set = video.setParameters.bind(video);
  vi.spyOn(video, "setParameters").mockImplementationOnce(async (params) => {
    await gate.promise;
    await set(params);
  });
  const first = h.host.setQuality(TARGETS.smooth);
  await flush();
  const second = h.host.setQuality(TARGETS.high);
  const newTrack = track("video", 4320);
  h.host.replaceTrack("video", newTrack);
  gate.resolve();
  await Promise.all([first, second]);
  await flush();
  expect(video.track).toBe(newTrack);
  expect(video.getParameters().encodings[0]).toMatchObject({
    maxBitrate: 8000000,
    scaleResolutionDownBy: 4,
  });
});

it("counts 15 seconds from peer:request even when fetching fresh ICE never finishes", async () => {
  const h = makeHost(),
    gate = deferred<RTCIceServer[]>(),
    errors = vi.fn();
  h.fetchIceServers.mockReturnValueOnce(gate.promise);
  h.host.onError(errors);
  await h.host.start();
  h.signal.request();
  await vi.advanceTimersByTimeAsync(14999);
  expect(errors).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(errors).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: "PEER_FAILED", memberId: "viewer" }),
  );
  gate.resolve([]);
  await flush();
  expect(h.connections).toHaveLength(0);
  expect(h.signal.sendSignal).not.toHaveBeenCalled();
});

it("replaces a duplicate request and keeps the new answer deadline despite a late matching-member answer", async () => {
  const h = makeHost(),
    error = vi.fn(),
    state = vi.fn();
  h.host.onError(error);
  h.host.onPeerState(state);
  await h.host.start();
  h.signal.request();
  await flush();
  const a = h.signal.description("offer");
  await vi.advanceTimersByTimeAsync(10000);
  h.signal.request();
  await flush();
  expect(h.connections[0]!.closed).toBe(true);
  const b = h.signal.description("offer");
  expect(b.negotiationId).not.toBe(a.negotiationId);
  const pc = h.connections[1]!,
    remote = vi.spyOn(pc, "setRemoteDescription");
  await vi.advanceTimersByTimeAsync(14999);
  h.signal.deliver("viewer", {
    type: "answer",
    negotiationId: a.negotiationId,
    sdp: sdp(),
  });
  await flush();
  expect(pc.closed).toBe(false);
  expect(remote).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(pc.closed).toBe(true);
  expect(state).toHaveBeenLastCalledWith({
    memberId: "viewer",
    state: "failed",
  });
  expect(error).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: "PEER_FAILED", memberId: "viewer" }),
  );
  expect(h.signal.sendSignal).toHaveBeenCalledTimes(2);
});

it("restarts only after five continuous seconds disconnected and times out 15 seconds after the restart offer is sent", async () => {
  const h = await withAnsweredPeer(),
    errors = vi.fn();
  h.host.onError(errors);
  h.pc.setIceConnectionState("disconnected");
  await vi.advanceTimersByTimeAsync(4999);
  h.pc.setIceConnectionState("completed");
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.pc.offerOptions).toEqual([{}]);
  const gate = deferred<void>(),
    create = h.pc.createOffer.bind(h.pc);
  const creating = vi
    .spyOn(h.pc, "createOffer")
    .mockImplementationOnce(async (options) => {
      await gate.promise;
      return create(options);
    });
  h.pc.setIceConnectionState("disconnected");
  await vi.advanceTimersByTimeAsync(3000);
  h.pc.setIceConnectionState("disconnected");
  await vi.advanceTimersByTimeAsync(1999);
  expect(creating).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(creating).toHaveBeenCalledExactlyOnceWith({ iceRestart: true });
  h.pc.setIceConnectionState("failed");
  await vi.advanceTimersByTimeAsync(16000);
  expect(h.pc.closed).toBe(false);
  gate.resolve();
  await flush();
  await vi.advanceTimersByTimeAsync(14999);
  expect(h.pc.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.pc.closed).toBe(true);
  expect(errors).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: "PEER_FAILED", memberId: "viewer" }),
  );
  expect(h.pc.offerOptions).toEqual([{}, { iceRestart: true }]);
});

it.each(["connected", "completed"] as const)(
  "resets the three-restart budget only on recovery to %s",
  async (recovery) => {
    const h = await withAnsweredPeer(),
      errors = vi.fn(),
      states = vi.fn();
    h.host.onPeerState(states);
    h.host.onError(errors);
    async function failAndAnswer() {
      h.pc.setIceConnectionState("failed");
      await flush();
      h.pc.setIceConnectionState("checking");
      answerHost(h.signal);
      await flush();
    }
    for (let n = 0; n < 3; n++) await failAndAnswer();
    h.pc.setIceConnectionState(recovery);
    expect(states).toHaveBeenLastCalledWith({
      memberId: "viewer",
      state: "playing",
    });
    for (let n = 0; n < 3; n++) await failAndAnswer();
    expect(h.pc.closed).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    h.pc.setIceConnectionState("failed");
    await flush();
    expect(h.pc.closed).toBe(true);
    expect(h.connections).toHaveLength(1);
    expect(h.pc.getTransceivers()).toHaveLength(2);
    expect(h.pc.offerOptions).toEqual([
      {},
      ...Array(6).fill({ iceRestart: true }),
    ]);
    const offers = h.signal.sendSignal.mock.calls.map(([, data]) => data);
    expect(offers.every((offer) => offer.type === "offer")).toBe(true);
    expect(new Set(offers.map((offer) => offer.negotiationId)).size).toBe(7);
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "PEER_FAILED", memberId: "viewer" }),
    );
    expect(states).toHaveBeenLastCalledWith({
      memberId: "viewer",
      state: "failed",
    });
    h.host.removePeer("viewer");
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("removePeer cancels a pending connection, and suppresses timers, stats and sender work on the removed peer", async () => {
  const h = await withAnsweredPeer(),
    stats = vi.fn(),
    error = vi.fn(),
    states = vi.fn();
  h.host.onStats(stats);
  h.host.onError(error);
  h.host.onPeerState(states);
  const pending = deferred<RTCIceServer[]>();
  h.fetchIceServers.mockReturnValueOnce(pending.promise);
  h.signal.request("other");
  h.host.removePeer("other");
  h.host.removePeer("other");
  const sample = deferred<RTCStatsReport>();
  vi.spyOn(h.pc, "getStats").mockReturnValue(sample.promise);
  const video = h.pc.getTransceivers()[0]!.sender,
    replaced = deferred<void>();
  vi.spyOn(video, "replaceTrack").mockReturnValueOnce(replaced.promise);
  const apply = vi.spyOn(video, "setParameters");
  h.host.replaceTrack("video", track("video", 720));
  h.pc.setIceConnectionState("disconnected");
  await vi.advanceTimersByTimeAsync(2000);
  h.host.removePeer("viewer");
  h.host.removePeer("viewer");
  pending.resolve([]);
  replaced.resolve();
  sample.resolve(new Map() as RTCStatsReport);
  await vi.advanceTimersByTimeAsync(30000);
  expect(apply).not.toHaveBeenCalled();
  expect(h.connections).toHaveLength(1);
  expect(h.pc.closed).toBe(true);
  expect(h.signal.sendSignal).toHaveBeenCalledTimes(1);
  expect(states.mock.calls.flat()).toEqual([
    { memberId: "other", state: "connecting" },
  ]);
  expect(stats).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("destroys pending SDP and subscriptions idempotently and leaves capture tracks live", async () => {
  const h = makeHost(),
    states = vi.fn(),
    errors = vi.fn(),
    peers = vi.fn();
  const captured = h.host.stream.getVideoTracks()[0]!;
  h.host.onState(states);
  h.host.onError(errors);
  h.host.onPeerState(peers);
  await h.host.start();
  await h.host.start();
  h.host.stop();
  h.host.stop();
  await h.host.start();
  const gate = deferred<void>();
  vi.spyOn(
    FakeRtcPeerConnection.prototype,
    "setLocalDescription",
  ).mockImplementationOnce(() => gate.promise);
  h.signal.request();
  await flush();
  const pc = h.connections[0]!,
    oldState = pc.oniceconnectionstatechange!,
    oldIce = pc.onicecandidate!;
  h.host.destroy();
  h.host.destroy();
  h.host.stop();
  gate.resolve();
  h.signal.request();
  oldState();
  oldIce({ candidate: null });
  await vi.advanceTimersByTimeAsync(30000);
  await expect(h.host.start()).rejects.toThrow();
  expect(states.mock.calls.flat()).toEqual(["live", "idle", "live"]);
  expect(peers.mock.calls.flat()).toEqual([
    { memberId: "viewer", state: "connecting" },
  ]);
  expect(errors).not.toHaveBeenCalled();
  expect(h.signal.sendSignal).not.toHaveBeenCalled();
  expect(h.connections).toHaveLength(1);
  expect(pc.closed).toBe(true);
  expect(captured.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("continues applying quality to remaining members when a removed PC's sender operation never settles", async () => {
  const h = makeHost(),
    errors = vi.fn();
  h.host.onError(errors);
  await h.host.start();
  h.signal.request("one");
  h.signal.request("two");
  await flush();
  const first = h.connections[0]!.getTransceivers()[0]!.sender;
  const second = h.connections[1]!.getTransceivers()[0]!.sender;
  const gate = deferred<void>();
  vi.spyOn(first, "setParameters").mockReturnValueOnce(gate.promise);
  const done = vi.fn();
  const changed = h.host.setQuality(TARGETS.smooth).then(done);
  await flush();
  h.host.removePeer("one");
  await flush();
  expect(second.getParameters().encodings[0]?.maxBitrate).toBe(3000000);
  expect(done).toHaveBeenCalledOnce();
  gate.reject(new Error());
  await changed;
  await flush();
  expect(errors).not.toHaveBeenCalled();
});

it("reapplies the latest track on restart and discards the previous round's pending stats, sender failure and ICE callbacks", async () => {
  const h = await withAnsweredPeer(),
    stats = vi.fn(),
    error = vi.fn();
  h.host.onStats(stats);
  h.host.onError(error);
  const sender = h.pc.getTransceivers()[0]!.sender;
  const sample = deferred<RTCStatsReport>(),
    replacing = deferred<void>();
  vi.spyOn(h.pc, "getStats").mockReturnValueOnce(sample.promise);
  vi.spyOn(sender, "replaceTrack").mockReturnValueOnce(replacing.promise);
  h.host.replaceTrack("video", track("video", 1080));
  await vi.advanceTimersByTimeAsync(2000);
  const staleIce = h.pc.onicecandidate!;
  h.pc.setIceConnectionState("failed");
  const latest = track("video", 4320);
  h.host.replaceTrack("video", latest);
  const updated = h.host.setQuality(TARGETS.high);
  staleIce({ candidate: null });
  replacing.reject(new Error());
  sample.resolve(new Map() as RTCStatsReport);
  await updated;
  await flush();
  expect(h.pc.offerOptions).toEqual([{}, { iceRestart: true }]);
  expect(sender.track).toBe(latest);
  expect(sender.getParameters().encodings[0]).toMatchObject({
    maxBitrate: 8000000,
    scaleResolutionDownBy: 4,
  });
  expect(stats).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(h.signal.sendSignal.mock.calls.map(([, data]) => data.type)).toEqual([
    "offer",
    "offer",
  ]);
});

it("rolls back the first signal subscription if the second fails at startup", async () => {
  const h = makeHost(),
    off = vi.fn(),
    states = vi.fn(),
    errors = vi.fn();
  h.host.onState(states);
  h.host.onError(errors);
  vi.spyOn(h.signal, "onSignal").mockReturnValue(off);
  vi.spyOn(h.signal, "onPeerRequest").mockImplementation(() => {
    throw new Error();
  });
  await expect(h.host.start()).rejects.toMatchObject({ code: "SIGNAL_ERROR" });
  await expect(h.host.start()).rejects.toMatchObject({ code: "SIGNAL_ERROR" });
  expect(states.mock.calls.flat()).toEqual(["error"]);
  expect(off).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledOnce();
});
