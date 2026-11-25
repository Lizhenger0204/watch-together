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

type SourceCheck =
  | { status: "idle" | "checking" }
  | { status: "ready"; code: "OK" | "NO_AUDIO" }
  | { status: "warning"; code: "NO_AUDIO" }
  | {
      status: "error";
      code: Exclude<SourceCheckCode, "NO_AUDIO">;
      diagnostic?: SourceDiagnostic;
    };

/** 片源的高度與估計的平均位元率（streaming.md §2「原片位元率」）。 */
export type SourceInfo = { height: number; bitrate: number | null };

export function useLocalSource(
  onStreamChange?: (stream: MediaStream | null) => void,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const release = useRef<() => void>(undefined);
  const pendingStream = useRef<MediaStream | null>(null);
  const [check, setCheck] = useState<SourceCheck>({ status: "idle" });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [title, setTitle] = useState("");
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const notifyStreamChange = useEffectEvent((stream: MediaStream | null) => {
    onStreamChange?.(stream);
  });

  useEffect(() => () => release.current?.(), []);

  useEffect(() => {
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
    pendingStream.current = null;
    setStream(null);
    setInfo(null);
    setTitle(file.name.replace(/\.[^.]+$/, "") || file.name);
    setCheck({ status: "checking" });

    const controller = new AbortController();
    const { signal } = controller;
    const url = URL.createObjectURL(file);
    let captured: MediaStream | undefined;

    release.current = () => {
      controller.abort();
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
      captured = captureVideo(video);
      await probePlayback(video, signal, captured);
      if (signal.aborted) return;

      const code = classifyCapturedTracks(
        captured.getVideoTracks().length,
        captured.getAudioTracks().length,
      );
      if (code === "CAPTURE_FAILED")
        throw sourceFailure(video, code, "capture", captured);
      if (code === "NO_AUDIO") {
        pendingStream.current = captured;
        setCheck({ status: "warning", code });
        return;
      }

      setStream(captured);
      setCheck({ status: "ready", code });
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
    if (!pendingStream.current) return;
    setStream(pendingStream.current);
    pendingStream.current = null;
    setCheck({ status: "ready", code: "NO_AUDIO" });
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
