import { expect, test, vi } from "vitest";
import { withoutAudioTransportCc } from "../common/answer-tuning";
import { TWCC_ANSWER } from "../common/answer-tuning.fixtures";
import type { FakeRtcPeerConnection } from "../common/rtc-fake";
import type { HostTransportOptions } from "../index";
import {
  created,
  flush,
  gather,
  location,
  makeHost,
  settle,
  useRelayFakes,
} from "./test-fixtures";

// 轉發模式的 Safari 模式（streaming.md §2、§4）：WHIP 不能重新協商，直播中以
// encodings[].codec 在 SFU 已協商的 codec 間切換。

const http = useRelayFakes();

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
const RTX = { mimeType: "video/rtx", clockRate: 90000, sdpFmtpLine: "apt=96" };

const capabilities: HostTransportOptions["getCodecCapabilities"] = (kind) =>
  kind === "video"
    ? [BASELINE, CONSTRAINED]
    : [{ mimeType: "audio/opus", clockRate: 48000 }];

async function live(
  negotiated: RTCRtpCodec[],
  overrides?: Partial<HostTransportOptions>,
) {
  const made = makeHost(undefined, {
    getCodecCapabilities: capabilities,
    ...overrides,
  });
  const errors = vi.fn();
  made.host.onError(errors);
  const started = settle(made.host.start());
  await gather(made.connections);
  const pc = made.connections.at(-1) as FakeRtcPeerConnection;
  const transceiver = pc.getTransceivers().find((t) => t.kind === "video")!;
  // 模擬 SFU answer 套用後瀏覽器回報的已協商 codec。
  await transceiver.sender.setParameters({
    ...transceiver.sender.getParameters(),
    codecs: negotiated.map((codec, i) => ({ ...codec, payloadType: 96 + i })),
  });
  created(http().lastPost());
  await flush();
  expect(started).toMatchObject({ done: true, error: undefined });
  return { ...made, sender: transceiver.sender, transceiver, errors };
}

function encodingCodec(sender: { getParameters(): RTCRtpSendParameters }) {
  return (sender.getParameters().encodings[0] as { codec?: RTCRtpCodec }).codec;
}

test("Safari 模式建立的發布：offer 的 codec 偏好 42e0xx 優先，且不另外指定 encodings codec", async () => {
  const h = await live([CONSTRAINED, BASELINE], { safariMode: true });
  expect(h.transceiver.codecPreferences.slice(0, 2)).toEqual([
    CONSTRAINED,
    BASELINE,
  ]);
  expect(encodingCodec(h.sender)).toBeUndefined();
});

test("直播中開關：在已協商的 codec 間切換，不重新 WHIP、不中斷", async () => {
  const h = await live([BASELINE, RTX, CONSTRAINED]);
  expect(encodingCodec(h.sender)).toBeUndefined();

  h.host.setSafariMode(true);
  await flush();
  expect(encodingCodec(h.sender)).toEqual(CONSTRAINED);

  h.host.setSafariMode(false);
  await flush();
  expect(encodingCodec(h.sender)).toEqual(BASELINE);
  expect(http().posts()).toHaveLength(1);
  expect(http().deletes()).toHaveLength(0);
  expect(h.errors).not.toHaveBeenCalled();
});

test("SFU 沒協商 42e0xx 時回報 TRACK_ERROR，下次開播才套用", async () => {
  const h = await live([BASELINE]);
  h.host.setSafariMode(true);
  await flush();
  expect(h.errors).toHaveBeenCalledWith(
    expect.objectContaining({ code: "TRACK_ERROR" }),
  );

  // 停播再開播：新的 offer 依最新設定排序。
  h.host.stop();
  await flush();
  http().deletes()[0]!.respond(200);
  const restarted = settle(h.host.start());
  await gather(h.connections);
  expect(h.connections).toHaveLength(2);
  const pc = h.connections.at(-1) as FakeRtcPeerConnection;
  const video = pc.getTransceivers().find((t) => t.kind === "video")!;
  expect(video.codecPreferences[0]).toEqual(CONSTRAINED);
  void restarted;
});

test("瀏覽器不支援 encodings codec（設定後讀不回來）時回報 TRACK_ERROR", async () => {
  const h = await live([BASELINE, CONSTRAINED]);
  const original = h.sender.setParameters.bind(h.sender);
  vi.spyOn(h.sender, "setParameters").mockImplementation((parameters) => {
    for (const encoding of parameters.encodings)
      delete (encoding as { codec?: RTCRtpCodec }).codec;
    return original(parameters);
  });
  h.host.setSafariMode(true);
  await flush();
  expect(h.errors).toHaveBeenCalledWith(
    expect.objectContaining({ code: "TRACK_ERROR" }),
  );
});

test("WHIP 回應前切換：套用 answer 後才選 codec", async () => {
  const made = makeHost(undefined, { getCodecCapabilities: capabilities });
  const started = settle(made.host.start());
  await gather(made.connections);
  const pc = made.connections.at(-1) as FakeRtcPeerConnection;
  const sender = pc.getTransceivers().find((t) => t.kind === "video")!.sender;
  await sender.setParameters({
    ...sender.getParameters(),
    codecs: [BASELINE, CONSTRAINED].map((c, i) => ({ ...c, payloadType: i })),
  });
  made.host.setSafariMode(true);
  await flush();
  expect(encodingCodec(sender)).toBeUndefined();
  created(http().lastPost());
  await flush();
  expect(started).toMatchObject({ done: true, error: undefined });
  expect(encodingCodec(sender)).toEqual(CONSTRAINED);
});

test("頻寬估計：房主本機套用的 WHIP answer 拿掉音訊的 transport-cc（§2）", async () => {
  const made = makeHost(undefined, { getCodecCapabilities: capabilities });
  const started = settle(made.host.start());
  await gather(made.connections);
  const pc = made.connections.at(-1) as FakeRtcPeerConnection;
  http().lastPost().respond(201, TWCC_ANSWER, {
    "Content-Type": "application/sdp",
    Location: location(),
  });
  await flush();
  expect(started).toMatchObject({ done: true, error: undefined });
  expect(pc.remoteDescription?.sdp).toBe(withoutAudioTransportCc(TWCC_ANSWER));
  expect(pc.remoteDescription?.sdp).toContain("a=rtcp-fb:102 transport-cc");
  expect(pc.remoteDescription?.sdp).not.toContain("a=rtcp-fb:111 transport-cc");
});
