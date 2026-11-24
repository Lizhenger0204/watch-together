/** 測試用：Node 沒有 MediaStream／MediaStreamTrack，p2p 與 relay 的測試共用這兩個替身。 */
import { vi } from "vitest";

export class TestStream {
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  addTrack(track: MediaStreamTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((current) => current !== track);
  }
}

export function track(kind: "audio" | "video", height?: number) {
  return {
    id: crypto.randomUUID(),
    kind,
    contentHint: "",
    readyState: "live",
    getSettings: () => ({ height }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}
