import { estimateSourceBitrate } from "@project/shared";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  captureVideo,
  loadMetadata,
  probePlayback,
  sourceFailure,
} from "./browser-source";
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
    }
  | {
      status: "warning";
      code: "NO_AUDIO";
      frameFormat: string | null;
      converted: boolean;
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
}

/** 片源的高度與估計的平均位元率（streaming.md §2「原片位元率」）。 */
export type SourceInfo = { height: number; bitrate: number | null };

export function useLocalSource(
  onStreamChange?: (stream: MediaStream | null) => void,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const release = useRef<() => void>(undefined);
  const pendingSource = useRef<PendingSource | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const [check, setCheck] = useState<SourceCheck>({ status: "idle" });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [title, setTitle] = useState("");
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const notifyStreamChange = useEffectEvent(
    (nextStream: MediaStream | null) => {
      onStreamChange?.(nextStream);
    },
  );

  useEffect(() => () => release.current?.(), []);

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

  async function selectFile(file: File) {
    const video = videoRef.current;
    if (!video) return;

    release.current?.();
    pendingSource.current = null;
    activeStreamRef.current = null;
    setStream(null);
    setInfo(null);
    setTitle(file.name.replace(/\.[^.]+$/, "") || file.name);
    setCheck({ status: "checking" });

    const controller = new AbortController();
    const { signal } = controller;
    const url = URL.createObjectURL(file);
    let captured: MediaStream | undefined;
    let disposeConverter: (() => void) | undefined;

    release.current = () => {
      controller.abort();
      activeStreamRef.current = null;
      disposeConverter?.();
      disposeConverter = undefined;
      captured?.getTracks().forEach((track) => track.stop());
      video.pause();
      video.muted = false;
      video.loop = false;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };

    try {
      await loadMetadata(video, url, signal);
      signal.throwIfAborted();
      if (video.videoWidth <= 0 || video.videoHeight <= 0) {
        throw sourceFailure(video, "VIDEO_UNDECODABLE", "metadata");
      }
      setInfo({
        height: video.videoHeight,
        bitrate: estimateSourceBitrate(file.size, video.duration),
      });
      const capturedStream = captureVideo(video);
      captured = capturedStream;
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
        };
        setCheck({ status: "warning", code, frameFormat, converted });
        return;
      }

      activeStreamRef.current = outputStream;
      setStream(outputStream);
      setCheck({ status: "ready", code, frameFormat, converted });
    } catch (error) {
      if (signal.aborted) return;
      release.current?.();
      release.current = undefined;
      setInfo(null);
      const code =
        error instanceof SourceCheckError ? error.code : "VIDEO_UNDECODABLE";
      setCheck({
        status: "error",
        code,
        diagnostic:
          error instanceof SourceCheckError ? error.diagnostic : undefined,
      });
    }
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
    });
  }

  return {
    videoRef,
    title,
    stream,
    info,
    check,
    selectFile,
    continueWithoutAudio,
  };
}
