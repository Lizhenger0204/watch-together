import type { SourceCheckStage, SourceDiagnostic } from "./source-check";

const STAGES: Record<SourceCheckStage, string> = {
  metadata: "載入中繼資料",
  playback: "靜音試播",
  capture: "擷取影音",
  rewind: "回到起點",
};

export function SourceDiagnostics({
  diagnostic,
}: {
  diagnostic: SourceDiagnostic;
}) {
  return (
    <details className="mt-2 text-xs text-zinc-600">
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
          瀏覽器媒體錯誤：
          {diagnostic.mediaError
            ? `${diagnostic.mediaError.code} ${diagnostic.mediaError.message}`
            : "無"}
          {diagnostic.failure ? `（${diagnostic.failure}）` : ""}
        </p>
      </div>
    </details>
  );
}
