import { useState } from "react";
import { HostSourcePlayer } from "./HostSourcePlayer";
import { useLocalSource } from "./use-local-source";

export function SourceDemo() {
  const [tracks, setTracks] = useState({ video: 0, audio: 0 });
  const source = useLocalSource((stream) => {
    setTracks({
      video: stream?.getVideoTracks().length ?? 0,
      audio: stream?.getAudioTracks().length ?? 0,
    });
  });

  return (
    <main className="grid gap-4 p-4">
      <h1 className="text-xl font-bold">本地影片擷取</h1>
      <HostSourcePlayer source={source} />
      <p>
        擷取音軌 {tracks.audio}・擷取影像軌 {tracks.video}
      </p>
    </main>
  );
}
