/**
 * 房主端 HEVC 標頭矛盾偵測與零複製修補入口（T-138，ADR 0006）。
 */

import {
  inspectMkvHevc,
  patchMkvZeroCopy,
  type MkvHevcInspection,
} from "./hevc-mkv";
import {
  inspectMp4Hevc,
  patchMp4ZeroCopy,
  type Mp4HevcInspection,
} from "./hevc-mp4";
import { sliceBlobBytes, type ZeroCopyFixResult } from "./hevc-patch";
import type { SourceCheckStage } from "./source-check";

export type HevcContainerInspection = Mp4HevcInspection | MkvHevcInspection;
export type { ZeroCopyFixResult };

export interface InitialTrialFailure {
  stage: SourceCheckStage;
  mediaError: { code: number; message: string } | null;
  failure: string | null;
  decodedFrames: number;
  currentTime: number;
}

export interface HevcProfileDiagnostic {
  declaredProfile: string;
  bitDepthLuma: number;
  bitDepthChroma: number;
  mismatch: boolean;
  autoFix: "none" | "applied" | "skipped" | "retry-failed";
  reason: string | null;
  /** 自動修正重試亦失敗時，保留首次原檔試播的失敗診斷（ADR 0006）。 */
  initialAttempt?: InitialTrialFailure | null;
}

export const HEVC_FIX_COMMANDS = {
  nvenc:
    'ffmpeg -i "input.mkv" -c:v hevc_nvenc -profile:v main -pix_fmt yuv420p -cq 20 -tag:v hvc1 -c:a copy -movflags +faststart "output.mp4"',
  cpu: 'ffmpeg -i "input.mkv" -c:v libx265 -pix_fmt yuv420p -crf 20 -tag:v hvc1 -c:a copy -movflags +faststart "output.mp4"',
} as const;

/**
 * 選檔時透過 File.slice() 輕量檢查是否為 HEVC 以及是否存在「Main 10 標頭／實際 8-bit」矛盾。
 * 解析失敗或非 HEVC 影片時回傳 null，絕不阻斷正常試播。
 */
export async function inspectHevcProfile(
  file: Blob,
): Promise<HevcContainerInspection | null> {
  try {
    const magic = await sliceBlobBytes(file, 0, 12);
    if (magic.length < 8) return null;
    if (
      magic[0] === 0x1a &&
      magic[1] === 0x45 &&
      magic[2] === 0xdf &&
      magic[3] === 0xa3
    ) {
      return await inspectMkvHevc(file);
    }
    return await inspectMp4Hevc(file);
  } catch {
    return null;
  }
}

/** 對已確認標頭矛盾的片源嘗試零複製 Blob 拼接修補（不重新編碼、不複製整檔）。 */
export async function buildZeroCopyHevcProfileFix(
  file: Blob,
  inspection: HevcContainerInspection,
): Promise<ZeroCopyFixResult> {
  try {
    if (inspection.container === "mp4") {
      return await patchMp4ZeroCopy(file, inspection);
    }
    return await patchMkvZeroCopy(file, inspection);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "patch-error",
    };
  }
}

export function toHevcProfileDiagnostic(
  inspection: HevcContainerInspection | null,
  autoFix: HevcProfileDiagnostic["autoFix"],
  reason: string | null = null,
  initialAttempt: InitialTrialFailure | null = null,
): HevcProfileDiagnostic | null {
  if (!inspection) return null;
  return {
    declaredProfile: inspection.info.declaredProfileName,
    bitDepthLuma: inspection.info.bitDepthLuma,
    bitDepthChroma: inspection.info.bitDepthChroma,
    mismatch: inspection.info.mismatchMain10On8Bit,
    autoFix,
    reason: reason ?? inspection.info.unsafeReason,
    initialAttempt,
  };
}
