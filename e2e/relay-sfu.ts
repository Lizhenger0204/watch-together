import type { Browser, Page } from "@playwright/test";

const RELAY_ROUTE = /\/api\/rooms\/([^/]+)\/(whip|whep|relay\/[\w-]+)$/;

type RelayAnswer = { id: string; sdp: string };

interface SfuPublication {
  id: string;
  pc: RTCPeerConnection;
  tracks: Partial<Record<"video" | "audio", MediaStreamTrack>>;
  sink: HTMLVideoElement;
}

interface SfuResource {
  roomId: string;
  role: "whip" | "whep";
  pc: RTCPeerConnection;
}

interface RelaySfuRuntime {
  publish(roomId: string, offerSdp: string): Promise<RelayAnswer>;
  subscribe(roomId: string, offerSdp: string): Promise<RelayAnswer | null>;
  remove(roomId: string, id: string): boolean;
  openPeers(): number;
  closeAll(): void;
}

declare global {
  interface Window {
    __relaySfu?: RelaySfuRuntime;
  }
}

export interface RelaySfuStats {
  /** 在 POST 入口記錄的實際請求次數（含 409 等非 201 回應）。 */
  whipRequests: number;
  whepRequests: number;
  /** 成功建立（201）的資源 Location 清單，用來逐一比對 DELETE。 */
  whip: string[];
  whep: string[];
  deleted: string[];
  viewerWhip: number;
  hostWhep: number;
  missingAuth: number;
  badContentType: number;
}

export interface RelaySfu {
  attach(page: Page, role: "host" | "viewer"): Promise<void>;
  stats(): RelaySfuStats;
  openPeers(): Promise<number>;
  close(): Promise<void>;
}

/**
 * 在獨立的 Playwright 空白頁建立本機真實 WebRTC SFU 替身：
 * - WHIP：建 inbound RTCPeerConnection 接收房主影音軌並回 201 + answer SDP + Location。
 * - WHEP：建 outbound RTCPeerConnection 掛上已收到的影音軌並回 201 + answer SDP + Location。
 * - DELETE：關閉對應連線並記錄刪除，完全不呼叫外部 API。
 */
export async function createRelaySfu(browser: Browser): Promise<RelaySfu> {
  const context = await browser.newContext();
  const sfuPage = await context.newPage();
  await sfuPage.setContent("<!doctype html><title>Relay SFU</title>");

  await sfuPage.evaluate(() => {
    let seq = 0;
    const publications = new Map<string, SfuPublication>();
    const resources = new Map<string, SfuResource>();
    // 獨立保留所有建立過的 PC 參照，確保 remove() 若漏掉 pc.close() 會被 openPeers() 抓出。
    const allPeers: RTCPeerConnection[] = [];

    function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number) {
      if (pc.iceGatheringState === "complete") return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        };
        const onChange = () => {
          if (pc.iceGatheringState === "complete") finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        pc.addEventListener("icegatheringstatechange", onChange);
      });
    }

    function disposePublication(roomId: string, pub: SfuPublication) {
      if (publications.get(roomId)?.id === pub.id) publications.delete(roomId);
      pub.sink.srcObject = null;
      pub.sink.remove();
    }

    window.__relaySfu = {
      async publish(roomId, offerSdp) {
        const previous = publications.get(roomId);
        if (previous) {
          resources.delete(previous.id);
          previous.pc.close();
          disposePublication(roomId, previous);
        }

        const pc = new RTCPeerConnection({ iceServers: [] });
        allPeers.push(pc);
        const id = `whip-${++seq}`;
        const tracks: Partial<Record<"video" | "audio", MediaStreamTrack>> = {};
        const inbound = new MediaStream();

        const recordTrack = (track: MediaStreamTrack) => {
          if (track.kind !== "video" && track.kind !== "audio") return;
          if (tracks[track.kind]) return;
          tracks[track.kind] = track;
          inbound.addTrack(track);
        };
        pc.ontrack = (event) => recordTrack(event.track);

        await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
        for (const receiver of pc.getReceivers()) recordTrack(receiver.track);

        // 掛上靜音 video 讓 Chrome 持續拉動遠端解碼管線，不影響轉送出去的原始音軌。
        const sink = document.createElement("video");
        sink.muted = true;
        sink.autoplay = true;
        sink.playsInline = true;
        sink.srcObject = inbound;
        document.body.append(sink);
        void sink.play().catch(() => {});

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc, 2_000);
        const sdp = pc.localDescription?.sdp;
        if (!sdp) {
          pc.close();
          sink.srcObject = null;
          sink.remove();
          throw new Error("SFU 無法產生 WHIP answer SDP");
        }

        publications.set(roomId, { id, pc, tracks, sink });
        resources.set(id, { roomId, role: "whip", pc });
        return { id, sdp };
      },

      async subscribe(roomId, offerSdp) {
        const pub = publications.get(roomId);
        if (!pub) return null;

        const pc = new RTCPeerConnection({ iceServers: [] });
        allPeers.push(pc);
        const id = `whep-${++seq}`;
        await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
        for (const transceiver of pc.getTransceivers()) {
          const kind = transceiver.receiver.track.kind;
          const track =
            kind === "video" || kind === "audio" ? pub.tracks[kind] : undefined;
          if (!track) continue;
          transceiver.direction = "sendonly";
          await transceiver.sender.replaceTrack(track);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc, 2_000);
        const sdp = pc.localDescription?.sdp;
        if (!sdp) {
          pc.close();
          throw new Error("SFU 無法產生 WHEP answer SDP");
        }

        resources.set(id, { roomId, role: "whep", pc });
        return { id, sdp };
      },

      remove(roomId, id) {
        const entry = resources.get(id);
        if (!entry || entry.roomId !== roomId) return false;
        resources.delete(id);
        entry.pc.close();
        if (entry.role === "whip") {
          const pub = publications.get(roomId);
          if (pub?.id === id) disposePublication(roomId, pub);
        }
        return true;
      },

      openPeers() {
        let count = 0;
        for (const pc of allPeers) {
          if (pc.signalingState !== "closed") count += 1;
        }
        return count;
      },

      closeAll() {
        for (const pc of allPeers) pc.close();
        resources.clear();
        for (const [roomId, pub] of [...publications.entries()]) {
          disposePublication(roomId, pub);
        }
      },
    };
  });

  const recorded: RelaySfuStats = {
    whipRequests: 0,
    whepRequests: 0,
    whip: [],
    whep: [],
    deleted: [],
    viewerWhip: 0,
    hostWhep: 0,
    missingAuth: 0,
    badContentType: 0,
  };
  const attached: Page[] = [];
  let closed = false;

  return {
    async attach(page, role) {
      attached.push(page);
      await page.route(RELAY_ROUTE, async (route) => {
        if (closed) return route.abort();
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        const match = pathname.match(
          /^\/api\/rooms\/([^/]+)\/(whip|whep|relay\/([\w-]+))$/,
        );
        if (!match) return route.abort();

        const roomId = decodeURIComponent(match[1]!);
        const endpoint = match[2]!;
        const resourceId = match[3];
        const auth = request.headers().authorization ?? "";
        if (!auth.startsWith("Bearer ") || auth.length <= "Bearer ".length) {
          recorded.missingAuth += 1;
          return route.fulfill({ status: 401 });
        }

        if (
          request.method() === "POST" &&
          (endpoint === "whip" || endpoint === "whep")
        ) {
          const contentType = request.headers()["content-type"] ?? "";
          if (!contentType.toLowerCase().includes("application/sdp")) {
            recorded.badContentType += 1;
            return route.fulfill({ status: 400 });
          }
          if (endpoint === "whip") {
            recorded.whipRequests += 1;
            if (role !== "host") recorded.viewerWhip += 1;
          } else {
            recorded.whepRequests += 1;
            if (role !== "viewer") recorded.hostWhep += 1;
          }

          const offerSdp = request.postData() ?? "";
          const answer = await sfuPage.evaluate(
            ({ action, room, sdp }) => {
              const sfu = window.__relaySfu;
              if (!sfu) throw new Error("SFU 尚未初始化");
              return action === "whip"
                ? sfu.publish(room, sdp)
                : sfu.subscribe(room, sdp);
            },
            { action: endpoint, room: roomId, sdp: offerSdp },
          );
          if (!answer) {
            return route.fulfill({
              status: 409,
              json: {
                error: {
                  code: "STREAM_NOT_LIVE",
                  message: "目前沒有可收看的轉發直播",
                },
              },
            });
          }

          const location = `/api/rooms/${encodeURIComponent(roomId)}/relay/${answer.id}`;
          recorded[endpoint].push(location);
          return route.fulfill({
            status: 201,
            headers: {
              "Content-Type": "application/sdp",
              Location: location,
              "Cache-Control": "no-store",
            },
            body: answer.sdp,
          });
        }

        if (request.method() === "DELETE" && resourceId) {
          const ok = await sfuPage.evaluate(
            ({ room, id }) => window.__relaySfu?.remove(room, id) ?? false,
            { room: roomId, id: resourceId },
          );
          if (!ok) return route.fulfill({ status: 403 });
          recorded.deleted.push(pathname);
          return route.fulfill({ status: 200, body: "" });
        }

        return route.fulfill({ status: 405 });
      });
    },

    stats() {
      return {
        ...recorded,
        whip: [...recorded.whip],
        whep: [...recorded.whep],
        deleted: [...recorded.deleted],
      };
    },

    async openPeers() {
      if (closed) return 0;
      return sfuPage.evaluate(() => window.__relaySfu?.openPeers() ?? 0);
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        attached.map((page) =>
          page.isClosed()
            ? Promise.resolve()
            : page.unrouteAll({ behavior: "ignoreErrors" }),
        ),
      );
      if (!sfuPage.isClosed()) {
        await sfuPage
          .evaluate(() => window.__relaySfu?.closeAll())
          .catch(() => {});
      }
      await context.close();
    },
  };
}
