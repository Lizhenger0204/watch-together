export const SOURCE_ACCEPT = "video/mp4,video/quicktime,.mp4,.m4v,.mov,.mkv";

export type SourceCheckCode =
  "TIMEOUT" | "VIDEO_UNDECODABLE" | "NO_AUDIO" | "CAPTURE_UNSUPPORTED";

export class SourceCheckError extends Error {
  constructor(readonly code: Exclude<SourceCheckCode, "NO_AUDIO">) {
    super(code);
  }
}

export function computeScaleDownBy(videoHeight: number, targetHeight: number) {
  return Math.max(1, videoHeight / targetHeight);
}

export function classifyCapturedTracks(
  videoTracks: number,
  audioTracks: number,
) {
  if (videoTracks !== 1) return "VIDEO_UNDECODABLE";
  if (audioTracks === 0) return "NO_AUDIO";
  return "OK";
}
