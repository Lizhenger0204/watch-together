import { estimateSourceBitrate } from "@project/shared";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  captureVideo,
  loadMetadata,
  probePlayback,
  retireCapturedStream,
  sourceFailure,
} from "./browser-source";
import {
  buildZeroCopyHevcProfileFix,
  inspectHevcProfile,
  toHevcProfileDiagnostic,
  type HevcContainerInspection,
  type InitialTrialFailure,
} from "./hevc-header";
import {
  classifyCapturedTracks,
  SourceCheckError,
  type SourceCheckCode,
  type SourceDiagnostic,
} from "./source-check";
import {
  computeConversionSize,
  ConversionUnsupportedError,
  createEightBitVideoConverter,
  needsEightBitConversion,
  probeVideoFrameFormat,
} from "./video-conversion";

type SourceCheck =
  | { status: "idle" | "checking" }
  | {
      status: "ready";
      code: "OK" | "NO_AUDIO";
      frameFormat: string | null;
      converted: boolean;
      headerFixed: boolean;
    }
  | {
      status: "warning";
      code: "NO_AUDIO";
      frameFormat: string | null;
      converted: boolean;
      headerFixed: boolean;
    }
  | {
      status: "error";
      code: Exclude<SourceCheckCode, "NO_AUDIO">;
      diagnostic?: SourceDiagnostic;
    };

interface PendingSource {
  stream: MediaStream;
  frameFormat: string | null;
  converted: boolean;
  headerFixed: boolean;
}

interface PendingLoad {
  file: File;
  sourceBlob: Blob;
  selectionId: number;
  headerFixed: boolean;
  inspection: HevcContainerInspection | null;
  allowAutoFix: boolean;
  initialAttempt?: InitialTrialFailure | null;
}

/** 片源的高度與估計的平均位元率（streaming.md §2「原片位元率」）。 */
export type SourceInfo = { height: number; bitrate: number | null };

export function useLocalSource(
  onStreamChange?: (stream: MediaStream | null) => void,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const capturedVideoRef = useRef<HTMLVideoElement | null>(null);
  const release = useRef<() => void>(undefined);
  const pendingSource = useRef<PendingSource | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const pendingLoadRef = useRef<PendingLoad | null>(null);
  const selectionIdRef = useRef(0);
  const [videoKey, setVideoKey] = useState(0);
  const [check, setCheck] = useState<SourceCheck>({ status: "idle" });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [title, setTitle] = useState("");
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const notifyStreamChange = useEffectEvent(
    (nextStream: MediaStream | null) => {
      onStreamChange?.(nextStream);
    },
  );

  useEffect(
    () => () => {
      pendingLoadRef.current = null;
      selectionIdRef.current += 1;
      release.current?.();
    },
    [],
  );

  useEffect(() => {
    activeStreamRef.current = stream;
    const notify = () => notifyStreamChange(stream);
    stream?.addEventListener("addtrack", notify);
    stream?.addEventListener("removetrack", notify);
    notify();
    return () => {
      stream?.removeEventListener("addtrack", notify);
      stream?.removeEventListener("removetrack", notify);
    };
  }, [stream]);

  function scheduleLoad(load: PendingLoad, video: HTMLVideoElement) {
    // Chrome 會持續把同一個 <video> 的新片源軌道塞進先前 captureStream() 產生的舊 stream，
    // 而且停掉舊 stream 的音軌會把同一 <video> 共用的音訊擷取源也一起靜音。
    // 換檔或重試前若該 <video> 已擷取過，先掛載全新的 <video>（同時對舊 stream 執行 retireCapturedStream）。
    if (capturedVideoRef.current === video) {
      pendingLoadRef.current = load;
      setVideoKey((current) => current + 1);
      return;
    }
    void loadFileOnVideo(load, video);
  }

  async function loadFileOnVideo(load: PendingLoad, video: HTMLVideoElement) {
    if (load.selectionId !== selectionIdRef.current) return;

    const controller = new AbortController();
    const { signal } = controller;
    let url: string | undefined;
    let captured: MediaStream | undefined;
    let disposeConverter: (() => void) | undefined;
    let inspection = load.inspection;

    let released = false;
    release.current = () => {
      if (released) return;
      released = true;
      controller.abort();
      activeStreamRef.current = null;
      disposeConverter?.();
      disposeConverter = undefined;
      if (captured) retireCapturedStream(captured);
      video.pause();
      video.muted = false;
      video.loop = false;
      video.removeAttribute("src");
      video.load();
      if (url) URL.revokeObjectURL(url);
    };

    try {
      // 試播前僅以 File.slice() 輕量記錄檔頭資訊，不預先擋下（ADR 0006）。
      if (inspection === null && load.allowAutoFix) {
        inspection = await inspectHevcProfile(load.file);
        signal.throwIfAborted();
      }

      url = URL.createObjectURL(load.sourceBlob);
      await loadMetadata(video, url, signal);
      signal.throwIfAborted();
      if (video.videoWidth <= 0 || video.videoHeight <= 0) {
        throw sourceFailure(video, "VIDEO_UNDECODABLE", "metadata");
      }
      setInfo({
        height: video.videoHeight,
        bitrate: estimateSourceBitrate(load.file.size, video.duration),
      });
      const capturedStream = captureVideo(video);
      captured = capturedStream;
      capturedVideoRef.current = video;
      const prepared = await probePlayback(video, signal, capturedStream, {
        prepareCapture: async (track, trialSignal, progress) => {
          const probed = await probeVideoFrameFormat(track, trialSignal);
          if (probed.status === "unsupported") {
            throw sourceFailure(
              video,
              "CAPTURE_UNSUPPORTED",
              "capture",
              capturedStream,
            );
          }
          if (probed.status === "empty") {
            throw sourceFailure(
              video,
              "CAPTURE_FAILED",
              "capture",
              capturedStream,
            );
          }

          const { frameFormat } = probed;
          progress.setFrameFormat(frameFormat);

          if (!needsEightBitConversion(frameFormat)) {
            return {
              stream: capturedStream,
              frameFormat,
              converted: false,
            };
          }

          trialSignal.throwIfAborted();
          const { width, height } = computeConversionSize(
            video.videoWidth,
            video.videoHeight,
          );
          let converter: ReturnType<typeof createEightBitVideoConverter>;
          try {
            converter = createEightBitVideoConverter({
              captured: capturedStream,
              initialVideoTrack: track,
              width,
              height,
              onTracksChange: () => {
                if (
                  !signal.aborted &&
                  activeStreamRef.current === converter.stream
                ) {
                  notifyStreamChange(converter.stream);
                }
              },
            });
          } catch (error) {
            if (error instanceof ConversionUnsupportedError) {
              throw sourceFailure(
                video,
                "CAPTURE_UNSUPPORTED",
                "capture",
                capturedStream,
                error,
                { frameFormat, converted: false },
              );
            }
            throw sourceFailure(
              video,
              "CAPTURE_FAILED",
              "capture",
              capturedStream,
              error,
              { frameFormat, converted: true },
            );
          }

          disposeConverter = converter.dispose;
          progress.setConverted(true);
          try {
            await converter.waitForFirstFrame(trialSignal);
          } catch (error) {
            converter.dispose();
            if (disposeConverter === converter.dispose) {
              disposeConverter = undefined;
            }
            throw error;
          }

          return {
            stream: converter.stream,
            frameFormat,
            converted: true,
            dispose: converter.dispose,
          };
        },
      });
      if (signal.aborted) return;

      const outputStream = prepared?.stream ?? capturedStream;
      const frameFormat = prepared?.frameFormat ?? null;
      const converted = prepared?.converted ?? false;
      const code = classifyCapturedTracks(
        outputStream.getVideoTracks().length,
        outputStream.getAudioTracks().length,
      );
      if (code === "CAPTURE_FAILED") {
        throw sourceFailure(video, code, "capture", outputStream, undefined, {
          frameFormat,
          converted,
        });
      }
      if (code === "NO_AUDIO") {
        pendingSource.current = {
          stream: outputStream,
          frameFormat,
          converted,
          headerFixed: load.headerFixed,
        };
        setCheck({
          status: "warning",
          code,
          frameFormat,
          converted,
          headerFixed: load.headerFixed,
        });
        return;
      }

      activeStreamRef.current = outputStream;
      setStream(outputStream);
      setCheck({
        status: "ready",
        code,
        frameFormat,
        converted,
        headerFixed: load.headerFixed,
      });
    } catch (error) {
      if (signal.aborted || load.selectionId !== selectionIdRef.current) return;
      const rawCode =
        error instanceof SourceCheckError ? error.code : "VIDEO_UNDECODABLE";
      const baseDiagnostic =
        error instanceof SourceCheckError ? error.diagnostic : undefined;

      release.current?.();
      release.current = undefined;
      setInfo(null);

      const isDecodeFailure =
        rawCode === "VIDEO_UNDECODABLE" || rawCode === "PLAYBACK_FAILED";

      // 原生試播失敗且偵測為 Main 10／8-bit 標頭矛盾：先嘗試零複製 Blob 修補重試一次。
      if (
        load.allowAutoFix &&
        isDecodeFailure &&
        inspection?.info.mismatchMain10On8Bit
      ) {
        const initialAttempt: InitialTrialFailure | null = baseDiagnostic
          ? {
              stage: baseDiagnostic.stage,
              mediaError: baseDiagnostic.mediaError,
              failure: baseDiagnostic.failure,
              decodedFrames: baseDiagnostic.decodedFrames,
              currentTime: baseDiagnostic.currentTime,
            }
          : null;
        const fix = await buildZeroCopyHevcProfileFix(load.file, inspection);
        if (load.selectionId !== selectionIdRef.current) return;
        if (fix.ok) {
          scheduleLoad(
            {
              file: load.file,
              sourceBlob: fix.blob,
              selectionId: load.selectionId,
              headerFixed: true,
              inspection,
              allowAutoFix: false,
              initialAttempt,
            },
            video,
          );
          return;
        }
        const hevcProfile = toHevcProfileDiagnostic(
          inspection,
          "skipped",
          fix.reason,
        );
        setCheck({
          status: "error",
          code: "HEVC_PROFILE_MISMATCH",
          diagnostic: baseDiagnostic
            ? { ...baseDiagnostic, hevcProfile }
            : undefined,
        });
        return;
      }

      // 零複製修補後重試：僅解碼失敗才歸類為 HEVC_PROFILE_MISMATCH 並保留兩次試播診斷；
      // 擷取失敗或逾時等非解碼錯誤保留原錯誤碼，不誤導為 HEVC 標頭矛盾。
      if (load.headerFixed && inspection?.info.mismatchMain10On8Bit) {
        if (isDecodeFailure) {
          const hevcProfile = toHevcProfileDiagnostic(
            inspection,
            "retry-failed",
            null,
            load.initialAttempt ?? null,
          );
          setCheck({
            status: "error",
            code: "HEVC_PROFILE_MISMATCH",
            diagnostic: baseDiagnostic
              ? { ...baseDiagnostic, hevcProfile }
              : undefined,
          });
          return;
        }
        const hevcProfile = toHevcProfileDiagnostic(
          inspection,
          "applied",
          null,
          load.initialAttempt ?? null,
        );
        setCheck({
          status: "error",
          code: rawCode,
          diagnostic: baseDiagnostic
            ? { ...baseDiagnostic, hevcProfile }
            : undefined,
        });
        return;
      }

      const hevcProfile = toHevcProfileDiagnostic(inspection, "none", null);
      setCheck({
        status: "error",
        code: rawCode,
        diagnostic: baseDiagnostic
          ? { ...baseDiagnostic, hevcProfile }
          : undefined,
      });
    }
  }

  const startPendingLoad = useEffectEvent(() => {
    const pending = pendingLoadRef.current;
    const video = videoRef.current;
    if (!pending || !video || pending.selectionId !== selectionIdRef.current) {
      return;
    }
    pendingLoadRef.current = null;
    void loadFileOnVideo(pending, video);
  });

  useEffect(() => {
    startPendingLoad();
  }, [videoKey]);

  async function selectFile(file: File) {
    const video = videoRef.current;
    if (!video) return;

    const selectionId = ++selectionIdRef.current;
    pendingLoadRef.current = null;
    release.current?.();
    pendingSource.current = null;
    activeStreamRef.current = null;
    setStream(null);
    setInfo(null);
    setTitle(file.name.replace(/\.[^.]+$/, "") || file.name);
    setCheck({ status: "checking" });

    scheduleLoad(
      {
        file,
        sourceBlob: file,
        selectionId,
        headerFixed: false,
        inspection: null,
        allowAutoFix: true,
      },
      video,
    );
  }

  function continueWithoutAudio() {
    const pending = pendingSource.current;
    if (!pending) return;
    pendingSource.current = null;
    activeStreamRef.current = pending.stream;
    setStream(pending.stream);
    setCheck({
      status: "ready",
      code: "NO_AUDIO",
      frameFormat: pending.frameFormat,
      converted: pending.converted,
      headerFixed: pending.headerFixed,
    });
  }

  return {
    videoRef,
    videoKey,
    title,
    stream,
    info,
    check,
    selectFile,
    continueWithoutAudio,
  };
}
