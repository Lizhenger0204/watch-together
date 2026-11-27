import { useState } from "react";
import { HEVC_FIX_COMMANDS } from "./hevc-header";
import type {
  SourceCheckCode,
  SourceCheckStage,
  SourceDiagnostic,
} from "./source-check";

const STAGES: Record<SourceCheckStage, string> = {
  metadata: "載入中繼資料",
  playback: "靜音試播",
  capture: "擷取影音",
  rewind: "回到起點",
};

const AUTO_FIX_LABELS = {
  none: "未觸發",
  applied: "已套用",
  skipped: "未自動修正",
  "retry-failed": "自動修正後仍無法解碼",
} as const;

function CopyableCommand({
  label,
  command,
}: {
  label: string;
  command: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-700">{label}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="text-xs font-medium text-[#0072b2] underline-offset-2 hover:underline"
        >
          {copied ? "已複製" : "複製指令"}
        </button>
      </div>
      <code className="block overflow-x-auto rounded border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[11px] text-zinc-800">
        {command}
      </code>
    </div>
  );
}

export function SourceDiagnostics({
  diagnostic,
  code,
}: {
  diagnostic: SourceDiagnostic;
  code?: Exclude<SourceCheckCode, "NO_AUDIO">;
}) {
  const hevc = diagnostic.hevcProfile;

  return (
    <div className="mt-2 grid gap-2 text-xs text-zinc-600">
      {code === "HEVC_PROFILE_MISMATCH" && (
        <div
          data-testid="hevc-mismatch-guide"
          className="grid gap-2 rounded border border-amber-200 bg-amber-50/70 p-2.5 text-zinc-700"
        >
          <p>
            可先用 FFmpeg 重新封裝轉檔為標準 Main 8-bit（音訊不重壓；若原 MKV
            音訊為 AC-3 等格式，請把 <code>-c:a copy</code> 改為{" "}
            <code>-c:a aac -b:a 192k</code>）：
          </p>
          <CopyableCommand
            label="有 NVIDIA 顯示卡（推薦，最快）"
            command={HEVC_FIX_COMMANDS.nvenc}
          />
          <CopyableCommand
            label="沒有 NVIDIA 顯示卡（CPU 轉碼）"
            command={HEVC_FIX_COMMANDS.cpu}
          />
        </div>
      )}
      <details>
        <summary className="cursor-pointer">播放診斷</summary>
        <div className="mt-1 grid gap-1 break-words">
          <p>失敗階段：{STAGES[diagnostic.stage]}</p>
          <p>
            影像：{diagnostic.width} × {diagnostic.height}；已解碼影格：
            {diagnostic.decodedFrames}；播放時間：
            {diagnostic.currentTime.toFixed(3)} 秒
          </p>
          <p>
            readyState：{diagnostic.readyState}；擷取影像軌：
            {diagnostic.videoTracks ?? "尚未擷取"}；擷取音軌：
            {diagnostic.audioTracks ?? "尚未擷取"}
          </p>
          <p>
            畫面格式：{diagnostic.frameFormat ?? "尚未讀取"}；8-bit 轉換：
            {diagnostic.converted ? "是" : "否"}
          </p>
          {hevc && (
            <p>
              HEVC 標頭：{hevc.declaredProfile}（實際 {hevc.bitDepthLuma}-bit）
              {hevc.mismatch ? "，標頭矛盾" : ""}；自動修正：
              {AUTO_FIX_LABELS[hevc.autoFix]}
              {hevc.reason ? `（${hevc.reason}）` : ""}
            </p>
          )}
          {hevc?.initialAttempt && (
            <p>
              首次原檔試播：失敗階段 {STAGES[hevc.initialAttempt.stage]}
              ；已解碼影格：
              {hevc.initialAttempt.decodedFrames}；錯誤：
              {hevc.initialAttempt.mediaError
                ? `${hevc.initialAttempt.mediaError.code} ${hevc.initialAttempt.mediaError.message}`
                : "無"}
              {hevc.initialAttempt.failure
                ? `（${hevc.initialAttempt.failure}）`
                : ""}
            </p>
          )}
          <p>
            瀏覽器媒體錯誤：
            {diagnostic.mediaError
              ? `${diagnostic.mediaError.code} ${diagnostic.mediaError.message}`
              : "無"}
            {diagnostic.failure ? `（${diagnostic.failure}）` : ""}
          </p>
        </div>
      </details>
    </div>
  );
}
