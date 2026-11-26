/**
 * 編碼與畫質（docs/specs/streaming.md §2）。
 *
 * 純邏輯（codec 偏好）與「套用參數到 sender」分開，前者可以在 Node 測試環境
 * 直接測，後者靠 rtc-fake.ts 的 sender 測。
 */
import {
  AUDIO_MAX_BITRATE,
  videoEncodingPolicy,
  type EncodingTarget,
} from "@project/shared";
import type { RtcRtpSender, RtcRtpTransceiver } from "./rtc";

export { AUDIO_MAX_BITRATE };

/** 依 kind 取 codec 能力的函式；測試注入假的 capabilities。 */
export type CodecCapabilities = (kind: "audio" | "video") => RTCRtpCodec[];

const PACKETIZATION_MODE_1 = /(?:^|[;\s])packetization-mode=1(?:;|\s|$)/i;
const H264_BASELINE_PROFILE =
  /(?:^|[;\s])profile-level-id=4200[0-9a-f]{2}(?:;|\s|$)/i;
const H264_CONSTRAINED_BASELINE_PROFILE =
  /(?:^|[;\s])profile-level-id=42e0[0-9a-f]{2}(?:;|\s|$)/i;

/** 預設：從瀏覽器取得發送端（sendonly）codec 能力。 */
export const browserCodecCapabilities: CodecCapabilities = (kind) =>
  RTCRtpSender.getCapabilities(kind)?.codecs ?? [];

/** 預設：從瀏覽器取得接收端（recvonly）codec 能力（WHEP 等使用）。 */
export const browserReceiverCodecCapabilities: CodecCapabilities = (kind) =>
  typeof RTCRtpReceiver !== "undefined"
    ? (RTCRtpReceiver.getCapabilities?.(kind)?.codecs ?? [])
    : [];

/** 依 §2 設定 video sender 的編碼參數（碼率、幀率、縮放、降級策略）。`target` 由 resolveQuality() 算出。 */
export async function applyVideoEncoding(
  sender: RtcRtpSender,
  target: EncodingTarget,
  sourceHeight: number,
): Promise<void> {
  const parameters = sender.getParameters();
  const { scaleResolutionDownBy, degradationPreference } = videoEncodingPolicy(
    sourceHeight,
    target.targetHeight,
  );
  // degradationPreference 是 RTCRtpSendParameters 的欄位，不是 per-encoding。
  parameters.degradationPreference = degradationPreference;
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = target.maxBitrate;
    // 「原片」FPS 不設上限；要拿掉先前設過的值，否則會沿用舊的上限。
    if (target.maxFramerate === null) delete encoding.maxFramerate;
    else encoding.maxFramerate = target.maxFramerate;
    encoding.scaleResolutionDownBy = scaleResolutionDownBy;
  }
  await sender.setParameters(parameters);
}

/** 依 §2 設定 audio sender 的編碼參數（Opus，上限 128 kbps）。 */
export async function applyAudioEncoding(sender: RtcRtpSender): Promise<void> {
  const parameters = sender.getParameters();
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = AUDIO_MAX_BITRATE;
  }
  await sender.setParameters(parameters);
}

/** 依 §2 設定 video track 的 contentHint（`motion`）。 */
export function setVideoContentHint(track: MediaStreamTrack): void {
  if ("contentHint" in track) {
    track.contentHint = "motion";
  }
}

/** 房主端 codec 偏好選項（streaming.md §2「Safari 模式」，T-139）。 */
export interface VideoCodecOptions {
  /**
   * Safari 模式：H.264 內改為 Constrained Baseline `42e0xx` 排第一、Baseline `4200xx` 第二，
   * 讓所有收看者都走 Safari 收看端那條編碼路徑（macOS Chrome 上為軟體 OpenH264）。預設 false。
   */
  safariMode?: boolean;
}

/**
 * 依 §2（T-139）：video codec 偏好 H.264 優先，其次 VP8，其餘 video codec 依原順序排在後面。
 * H.264 內固定優先 `packetization-mode=1`：Baseline `4200xx` → Constrained Baseline `42e0xx`
 * → 其餘 `packetization-mode=1`（或未帶 fmtp）→ 其餘 H.264（例如 `packetization-mode=0`）。
 * Safari 模式時前兩者對調：`42e0xx` → `4200xx`。
 */
export function preferredVideoCodecs(
  codecs: readonly RTCRtpCodec[],
  { safariMode = false }: VideoCodecOptions = {},
): RTCRtpCodec[] {
  const [baseline, constrained] = safariMode ? [1, 0] : [0, 1];
  const priority = (codec: RTCRtpCodec): number => {
    const mime = codec.mimeType.toLowerCase();
    if (mime === "video/h264") {
      const fmtp = codec.sdpFmtpLine?.trim() ?? "";
      if (fmtp === "") return 2;
      const pm1 = PACKETIZATION_MODE_1.test(fmtp);
      if (pm1 && H264_BASELINE_PROFILE.test(fmtp)) return baseline;
      if (pm1 && H264_CONSTRAINED_BASELINE_PROFILE.test(fmtp))
        return constrained;
      if (pm1) return 2;
      return 3;
    }
    if (mime === "video/vp8") return 4;
    return 5;
  };
  return codecs
    .filter((codec) => codec.mimeType.toLowerCase().startsWith("video/"))
    .sort((a, b) => priority(a) - priority(b));
}

/** Chrome 已支援、TS DOM 型別尚未收錄的 `RTCRtpEncodingParameters.codec`。 */
type EncodingWithCodec = RTCRtpEncodingParameters & { codec?: RTCRtpCodec };

function codecKey(codec: RTCRtpCodec | undefined) {
  return codec
    ? `${codec.mimeType.toLowerCase()} ${codec.sdpFmtpLine?.trim() ?? ""}`
    : "";
}

/** 是否為 Safari 模式要的 Constrained Baseline（`42e0xx`，`packetization-mode=1`）。 */
export function isConstrainedBaselineH264(codec: RTCRtpCodec): boolean {
  const fmtp = codec.sdpFmtpLine ?? "";
  return (
    codec.mimeType.toLowerCase() === "video/h264" &&
    PACKETIZATION_MODE_1.test(fmtp) &&
    H264_CONSTRAINED_BASELINE_PROFILE.test(fmtp)
  );
}

/**
 * 轉發模式切換 Safari 模式（§4，WHIP 不能重新協商）：在這條連線**已協商**的 video codec 中，
 * 依 `preferredVideoCodecs(…, options)` 選出第一個，設到每個 encoding 的 `codec`。
 * 回傳選到的 codec；沒有已協商的 codec（或瀏覽器不提供）時回 null，不改參數。
 */
export async function selectNegotiatedVideoCodec(
  sender: RtcRtpSender,
  options: VideoCodecOptions,
): Promise<RTCRtpCodec | null> {
  const parameters = sender.getParameters();
  const negotiated = (parameters.codecs ?? []).map(
    ({ mimeType, clockRate, channels, sdpFmtpLine }): RTCRtpCodec => ({
      mimeType,
      clockRate,
      ...(channels === undefined ? {} : { channels }),
      ...(sdpFmtpLine === undefined ? {} : { sdpFmtpLine }),
    }),
  );
  const chosen = preferredVideoCodecs(
    negotiated.filter(
      (codec) => !/\/(rtx|red|ulpfec|flexfec-03)$/i.test(codec.mimeType),
    ),
    options,
  )[0];
  if (!chosen) return null;
  const encodings = parameters.encodings as EncodingWithCodec[];
  if (
    encodings.every((encoding) => codecKey(encoding.codec) === codecKey(chosen))
  )
    return chosen;
  for (const encoding of encodings) encoding.codec = chosen;
  await sender.setParameters(parameters);
  return chosen;
}

/** 依 §2：audio 只送 Opus。 */
export function preferredAudioCodecs(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  return codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === "audio/opus",
  );
}

/**
 * addTransceiver 之後呼叫：把傳入的 codec capabilities 依 transceiver.kind
 * 排成偏好順序（video：H.264 優先；audio：Opus），再設到 transceiver 上。
 * `codecs` 由 `options.getCodecCapabilities`（預設 `browserCodecCapabilities`）提供；
 * `options.safariMode` 只影響 video（見 `preferredVideoCodecs`）。
 */
export function applyCodecPreferences(
  transceiver: RtcRtpTransceiver,
  codecs: readonly RTCRtpCodec[],
  options: VideoCodecOptions = {},
): void {
  const preferred =
    transceiver.kind === "video"
      ? preferredVideoCodecs(codecs, options)
      : preferredAudioCodecs(codecs);
  transceiver.setCodecPreferences(preferred);
}
