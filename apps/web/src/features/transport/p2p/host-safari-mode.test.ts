import { expect, it, vi } from "vitest";
import { withoutAudioTransportCc } from "../common/answer-tuning";
import { TWCC_ANSWER } from "../common/answer-tuning.fixtures";
import type { HostTransportOptions } from "../index";
import {
  answerHost,
  flush,
  makeHost,
  makeViewer,
  sdp,
  track,
  useRtcFakes,
} from "./test-fixtures";

useRtcFakes();

// Safari 模式（streaming.md §2）：房主端 H.264 Constrained Baseline 優先，直播中切換時重新協商。

const BASELINE = {
  mimeType: "video/H264",
  clockRate: 90000,
  sdpFmtpLine:
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
};
const CONSTRAINED = {
  mimeType: "video/H264",
  clockRate: 90000,
  sdpFmtpLine:
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
};
const VP8 = { mimeType: "video/VP8", clockRate: 90000 };

const capabilities: HostTransportOptions["getCodecCapabilities"] = (kind) =>
  kind === "video"
    ? [VP8, BASELINE, CONSTRAINED]
    : [{ mimeType: "audio/opus", clockRate: 48000 }];

function videoTransceiver(h: ReturnType<typeof makeHost>) {
  return h.connections[0]!.getTransceivers().find((t) => t.kind === "video")!;
}

async function connected(overrides?: Partial<HostTransportOptions>) {
  const h = makeHost(undefined, {
    getCodecCapabilities: capabilities,
    ...overrides,
  });
  const peerStates = vi.fn();
  h.host.onPeerState(peerStates);
  await h.host.start();
  h.signal.request();
  await flush();
  answerHost(h.signal);
  await flush();
  h.connections[0]!.setIceConnectionState("connected");
  return { ...h, pc: h.connections[0]!, peerStates };
}

function offers(h: ReturnType<typeof makeHost>) {
  return h.signal.sendSignal.mock.calls.filter(
    ([, data]) => data.type === "offer",
  );
}

it("orders 42e0xx before 4200xx for new peers when created in Safari mode", async () => {
  const h = await connected({ safariMode: true });
  expect(videoTransceiver(h).codecPreferences.slice(0, 3)).toEqual([
    CONSTRAINED,
    BASELINE,
    VP8,
  ]);
});

it("renegotiates a connected peer on the same PC without ICE restart or a connecting state", async () => {
  const h = await connected();
  expect(videoTransceiver(h).codecPreferences[0]).toEqual(BASELINE);
  const first = h.signal.description("offer");

  h.host.setSafariMode(true);
  await flush();

  expect(videoTransceiver(h).codecPreferences[0]).toEqual(CONSTRAINED);
  expect(h.pc.offerOptions).toEqual([{}, {}]);
  const second = h.signal.description("offer");
  expect(second.negotiationId).not.toBe(first.negotiationId);
  expect(h.connections).toHaveLength(1);

  answerHost(h.signal);
  await flush();
  expect(h.pc.signalingState).toBe("stable");
  expect(h.peerStates.mock.calls.flat()).toEqual([
    { memberId: "viewer", state: "connecting" },
    { memberId: "viewer", state: "playing" },
  ]);

  // 關掉時同樣重新協商、Baseline 回到第一位；重複設定相同值不再協商。
  h.host.setSafariMode(false);
  await flush();
  expect(videoTransceiver(h).codecPreferences[0]).toEqual(BASELINE);
  answerHost(h.signal);
  await flush();
  h.host.setSafariMode(false);
  await flush();
  expect(offers(h)).toHaveLength(3);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
});

it("fails the peer when the renegotiation answer never arrives", async () => {
  const h = await connected();
  const errors = vi.fn();
  h.host.onError(errors);
  h.host.setSafariMode(true);
  await flush();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(errors).toHaveBeenCalledWith(
    expect.objectContaining({ code: "PEER_FAILED", memberId: "viewer" }),
  );
  expect(h.pc.closed).toBe(true);
});

it("defers the switch until a pending answer is applied, then renegotiates once", async () => {
  const h = makeHost(undefined, { getCodecCapabilities: capabilities });
  await h.host.start();
  h.signal.request();
  await flush();
  h.host.setSafariMode(true);
  await flush();
  expect(offers(h)).toHaveLength(1);

  answerHost(h.signal);
  await flush();
  // ICE 還沒連通：先不協商，連通後才補。
  expect(offers(h)).toHaveLength(1);
  h.connections[0]!.setIceConnectionState("connected");
  await flush();
  expect(offers(h)).toHaveLength(2);
  expect(h.connections[0]!.offerOptions).toEqual([{}, {}]);
  expect(videoTransceiver(h).codecPreferences[0]).toEqual(CONSTRAINED);
  answerHost(h.signal);
  await flush();
  expect(offers(h)).toHaveLength(2);
});

it("uses the latest mode when it flips back before the pending answer arrives", async () => {
  const h = makeHost(undefined, { getCodecCapabilities: capabilities });
  await h.host.start();
  h.signal.request();
  await flush();
  h.host.setSafariMode(true);
  h.host.setSafariMode(false);
  answerHost(h.signal);
  await flush();
  expect(offers(h)).toHaveLength(1);
});

it("keeps the viewer playing through a renegotiation on a connected PC", async () => {
  const v = makeViewer(),
    states = vi.fn();
  v.viewer.onState(states);
  await v.viewer.start();
  v.signal.deliver("host", { type: "offer", negotiationId: "A", sdp: sdp() });
  await flush();
  const pc = v.connections[0]!;
  pc.fireTrack(track("video"));
  pc.setIceConnectionState("connected");
  const renegotiated = sdp().replace("100 1 IN", "100 2 IN");
  v.signal.deliver("host", {
    type: "offer",
    negotiationId: "B",
    sdp: renegotiated,
  });
  await flush();
  expect(v.signal.description("answer").negotiationId).toBe("B");
  expect(v.connections).toHaveLength(1);
  expect(states.mock.calls.flat()).toEqual(["connecting", "playing"]);
});

it("applies answers without audio transport-cc, including renegotiation answers", async () => {
  const h = makeHost(undefined, { getCodecCapabilities: capabilities });
  await h.host.start();
  h.signal.request();
  await flush();
  const pc = h.connections[0]!;
  const answer = (id: string) =>
    h.signal.deliver("viewer", {
      type: "answer",
      negotiationId: id,
      sdp: TWCC_ANSWER,
    });
  answer(h.signal.description("offer").negotiationId);
  await flush();
  expect(pc.remoteDescription?.sdp).toBe(withoutAudioTransportCc(TWCC_ANSWER));
  pc.setIceConnectionState("connected");
  h.host.setSafariMode(true);
  await flush();
  answer(h.signal.description("offer").negotiationId);
  await flush();
  expect(pc.remoteDescription?.sdp).toBe(withoutAudioTransportCc(TWCC_ANSWER));
  expect(pc.signalingState).toBe("stable");
});

it("keeps the five-second ICE restart deadline when switching during a disconnect; the restart offer carries the new mode", async () => {
  const h = await connected();
  h.pc.setIceConnectionState("disconnected");
  await vi.advanceTimersByTimeAsync(2_000);
  h.host.setSafariMode(true);
  await flush();
  expect(h.pc.offerOptions).toEqual([{}]);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(h.pc.offerOptions).toEqual([{}, { iceRestart: true }]);
  expect(videoTransceiver(h).codecPreferences[0]).toEqual(CONSTRAINED);
  // restart 的 offer 已帶新模式：套用 answer 並連通後不再另外協商。
  answerHost(h.signal);
  await flush();
  h.pc.setIceConnectionState("connected");
  await flush();
  expect(h.pc.offerOptions).toEqual([{}, { iceRestart: true }]);
});

it("restarts ICE as soon as a renegotiation answer lands after the disconnect deadline passed", async () => {
  const h = await connected();
  h.host.setSafariMode(true);
  await flush();
  expect(h.pc.offerOptions).toEqual([{}, {}]);
  h.pc.setIceConnectionState("disconnected");
  await vi.advanceTimersByTimeAsync(5_000);
  // 還在等重新協商的 answer：不可蓋掉它。
  expect(h.pc.offerOptions).toEqual([{}, {}]);
  answerHost(h.signal);
  await flush();
  expect(h.pc.offerOptions).toEqual([{}, {}, { iceRestart: true }]);
});

it("renegotiates once ICE recovers by itself after a switch during a disconnect", async () => {
  const h = await connected();
  h.pc.setIceConnectionState("disconnected");
  h.host.setSafariMode(true);
  await flush();
  h.pc.setIceConnectionState("connected");
  await flush();
  expect(h.pc.offerOptions).toEqual([{}, {}]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.pc.offerOptions).toEqual([{}, {}]);
});

function heldRenegotiation() {
  return async () => {
    const v = makeViewer();
    const states = vi.fn();
    v.viewer.onState(states);
    await v.viewer.start();
    v.signal.deliver("host", { type: "offer", negotiationId: "A", sdp: sdp() });
    await flush();
    const pc = v.connections[0]!;
    pc.setIceConnectionState("connected");
    vi.spyOn(pc, "setRemoteDescription").mockReturnValueOnce(
      new Promise<void>(() => {}),
    );
    v.signal.deliver("host", {
      type: "offer",
      negotiationId: "B",
      sdp: sdp().replace("100 1 IN", "100 2 IN"),
    });
    return { pc, states };
  };
}

it("stays playing on a healthy ICE transition while a renegotiation offer is still being applied", async () => {
  const { pc, states } = await heldRenegotiation()();
  pc.setIceConnectionState("completed");
  expect(states.mock.calls.flat()).toEqual(["connecting", "playing"]);
});

it("still reports a real ICE outage while a renegotiation offer is being applied", async () => {
  const { pc, states } = await heldRenegotiation()();
  pc.setIceConnectionState("disconnected");
  expect(states.mock.calls.flat()).toEqual([
    "connecting",
    "playing",
    "connecting",
  ]);
});
