import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCodecPreferences } from "./encoding";
import {
  browserPeerConnectionFactory,
  type RtcSessionDescription,
} from "./rtc";
import { FakeRtcPeerConnection } from "./rtc-fake";

/** Only the native surface exercised by the adapter. The transceiver has no kind. */
class NativePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  onsignalingstatechange: (() => void) | null = null;
  localDescription: RtcSessionDescription | null = null;
  readonly transceiver = {
    sender: { track: null },
    receiver: { track: { kind: "video" } },
    setCodecPreferences: vi.fn<(codecs: RTCRtpCodec[]) => void>(),
  };

  addTransceiver() {
    return this.transceiver;
  }

  setIceGatheringState(state: RTCIceGatheringState) {
    this.iceGatheringState = state;
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }

  close() {
    this.signalingState = "closed";
  }
}

function createBrowserPeer() {
  const native = new NativePeer();
  vi.stubGlobal("RTCPeerConnection", function () {
    return native;
  });
  return { pc: browserPeerConnectionFactory({}), controls: native };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browserPeerConnectionFactory", () => {
  it("applies H264 first to a native video transceiver without kind", () => {
    const { pc, controls } = createBrowserPeer();
    expect(controls.transceiver).not.toHaveProperty("kind");
    const video = pc.addTransceiver("video", { direction: "sendonly" });
    const vp8 = { mimeType: "video/VP8", clockRate: 90000 };
    const h264 = { mimeType: "video/H264", clockRate: 90000 };
    applyCodecPreferences(video, [vp8, h264]);
    expect(controls.transceiver.setCodecPreferences).toHaveBeenCalledWith([
      h264,
      vp8,
    ]);
  });

  it("reads the current native SDP after gathering", async () => {
    const { pc, controls } = createBrowserPeer();
    expect(pc.localDescription).toBeNull();
    const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
    controls.localDescription = { type: "offer", sdp };
    const before = pc.localDescription;
    const done = pc.waitForIceGatheringComplete(1000);
    controls.localDescription = {
      type: "offer",
      sdp: sdp + "a=candidate:local\r\n",
    };
    controls.setIceGatheringState("complete");
    await done;
    expect(pc.localDescription).toEqual(controls.localDescription);
    expect(before?.sdp).not.toContain("candidate");
  });

  it("rejects a wait if the native connection reports closure", async () => {
    vi.useFakeTimers();
    const { pc, controls } = createBrowserPeer();
    const rejected = vi.fn();
    const done = pc.waitForIceGatheringComplete(1000).catch(rejected);
    controls.signalingState = "closed";
    controls.onsignalingstatechange?.();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ name: "InvalidStateError" }),
    );
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each([
  { name: "browser adapter", create: createBrowserPeer },
  {
    name: "fake",
    create: () => {
      const pc = new FakeRtcPeerConnection({});
      return { pc, controls: pc };
    },
  },
])("$name ICE gathering", ({ create }) => {
  it("waits through gathering and resolves immediately once complete", async () => {
    vi.useFakeTimers();
    const { pc, controls } = create();
    const ready = vi.fn();
    const done = pc.waitForIceGatheringComplete(1000).then(ready);
    controls.setIceGatheringState("gathering");
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    controls.setIceGatheringState("complete");
    await done;
    await pc.waitForIceGatheringComplete(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves only the wait whose deadline has expired", async () => {
    vi.useFakeTimers();
    const { pc, controls } = create();
    controls.setIceGatheringState("gathering");
    const short = vi.fn();
    const long = vi.fn();
    const first = pc.waitForIceGatheringComplete(100).then(short);
    const second = pc.waitForIceGatheringComplete(1000).then(long);
    await vi.advanceTimersByTimeAsync(99);
    expect(short).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(long).not.toHaveBeenCalled();
    controls.setIceGatheringState("complete");
    await second;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a pending or subsequent wait when closed", async () => {
    vi.useFakeTimers();
    const { pc } = create();
    const invalidState = { name: "InvalidStateError" };
    const done = expect(
      pc.waitForIceGatheringComplete(1000),
    ).rejects.toMatchObject(invalidState);
    pc.close();
    await done;
    await expect(pc.waitForIceGatheringComplete(1000)).rejects.toMatchObject(
      invalidState,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
