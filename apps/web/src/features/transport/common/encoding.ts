/**
 * 編碼與畫質（docs/specs/streaming.md §2）。
 *
 * 純邏輯（codec 偏好）與「套用參數到 sender」分開，前者可以在 Node 測試環境
 * 直接測，後者靠 rtc-fake.ts 的 sender 測。
 */
import { AUDIO_MAX_BITRATE, type QualityPreset } from "@project/shared";
import { computeScaleDownBy } from "../../source/source-check";
import type { RtcRtpSender, RtcRtpTransceiver } from "./rtc";

export { AUDIO_MAX_BITRATE };

/** 依 §2 設定 video sender 的編碼參數（碼率、幀率、縮放、降級策略）。 */
export function applyVideoEncoding(
  sender: RtcRtpSender,
  preset: QualityPreset,
  sourceHeight: number,
): void {
  const parameters = sender.getParameters();
  // degradationPreference 是 RTCRtpSendParameters 的欄位，不是 per-encoding。
  parameters.degradationPreference = "maintain-framerate";
  const scaleResolutionDownBy = computeScaleDownBy(
    sourceHeight,
    preset.targetHeight,
  );
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = preset.maxBitrate;
    encoding.maxFramerate = preset.maxFramerate;
    encoding.scaleResolutionDownBy = scaleResolutionDownBy;
  }
  void sender.setParameters(parameters);
}

/** 依 §2 設定 audio sender 的編碼參數（Opus，上限 128 kbps）。 */
export function applyAudioEncoding(sender: RtcRtpSender): void {
  const parameters = sender.getParameters();
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = AUDIO_MAX_BITRATE;
  }
  void sender.setParameters(parameters);
}

/** 依 §2 設定 video track 的 contentHint（`motion`）。 */
export function setVideoContentHint(track: MediaStreamTrack): void {
  if ("contentHint" in track) {
    track.contentHint = "motion";
  }
}

/** 依 §2：video codec 偏好 H.264 優先，其次 VP8（不保留其他 video codec）。 */
export function preferredVideoCodecs(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  const priority = (codec: RTCRtpCodec): number => {
    const mime = codec.mimeType.toLowerCase();
    if (mime === "video/h264") return 0;
    if (mime === "video/vp8") return 1;
    return 2;
  };
  return codecs
    .filter((codec) => codec.mimeType.toLowerCase().startsWith("video/"))
    .sort((a, b) => priority(a) - priority(b));
}

/** 依 §2：audio 只送 Opus。 */
export function preferredAudioCodecs(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  return codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === "audio/opus",
  );
}

/** addTransceiver 之後呼叫：依 kind 設定 codec 偏好（H.264 優先 / Opus）。 */
export function applyCodecPreferences(transceiver: RtcRtpTransceiver): void {
  const capabilities =
    RTCRtpSender.getCapabilities(transceiver.kind)?.codecs ?? [];
  const preferred =
    transceiver.kind === "video"
      ? preferredVideoCodecs(capabilities)
      : preferredAudioCodecs(capabilities);
  transceiver.setCodecPreferences(preferred);
}
