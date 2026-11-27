import type { HevcProfileDiagnostic } from "./hevc-header";

export const SOURCE_ACCEPT = "video/mp4,video/quicktime,.mp4,.m4v,.mov,.mkv";

export type SourceCheckCode =
  | "TIMEOUT"
  | "VIDEO_UNDECODABLE"
  | "HEVC_PROFILE_MISMATCH"
  | "NO_AUDIO"
  | "CAPTURE_UNSUPPORTED"
  | "CAPTURE_FAILED"
  | "PLAYBACK_FAILED";

export type SourceCheckStage = "metadata" | "playback" | "capture" | "rewind";

export interface SourceDiagnostic {
  stage: SourceCheckStage;
  mediaError: { code: number; message: string } | null;
  failure: string | null;
  width: number;
  height: number;
  readyState: number;
  currentTime: number;
  decodedFrames: number;
  videoTracks: number | null;
  audioTracks: number | null;
  frameFormat: string | null;
  converted: boolean;
  hevcProfile?: HevcProfileDiagnostic | null;
}

export class SourceCheckError extends Error {
  constructor(
    readonly code: Exclude<SourceCheckCode, "NO_AUDIO">,
    readonly diagnostic?: SourceDiagnostic,
  ) {
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
  if (videoTracks !== 1) return "CAPTURE_FAILED";
  if (audioTracks === 0) return "NO_AUDIO";
  return "OK";
}
