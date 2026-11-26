import { expect, type Page, type TestInfo } from "@playwright/test";
import { submitJoin } from "./join-room";
import { beginWatching } from "./p2p-media";
import { test } from "./room-pages";
import { fixture, nativePlayback } from "./source-media";

export interface CaptureAuditEntry {
  tracks: Map<MediaStreamTrack, string>;
}

export interface Bug004Audit {
  selection: string;
  captures: CaptureAuditEntry[];
  generators: MediaStreamTrack[];
}

export interface GeneratorTrackLike extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}

export interface Bug004Gate {
  armed: boolean;
  held: boolean;
  generators: GeneratorTrackLike[];
  arm: () => void;
  release: () => void;
}

type CaptureStreamVideoProto = HTMLVideoElement & {
  captureStream?: () => MediaStream;
};

export type GlobalWithMediaStreams = Window & {
  MediaStreamTrackGenerator?: new (init: {
    kind: "video" | "audio";
  }) => GeneratorTrackLike;
  bug004VideoTrack?: MediaStreamTrack | null;
  bug004Audit?: Bug004Audit;
  bug004Gate?: Bug004Gate;
};

export async function requireNativeHevc(
  page: Page,
  fileName: string,
  testInfo: TestInfo,
) {
  const path = fixture(fileName);
  const native = await nativePlayback(page, path, testInfo);
  const decodable =
    native.mediaError === null &&
    native.width > 0 &&
    native.frames > 2 &&
    native.currentTime >= 1;
  test.skip(
    !decodable && process.env.HEVC_REQUIRED !== "1",
    `原生 Chrome 無法完成 ${fileName} 解碼；Main 10 P2P 案例未驗證（width=${native.width}, frames=${native.frames}, time=${native.currentTime}, MediaError=${native.mediaError?.code ?? "無"}）。以 HEVC_REQUIRED=1 可強制此能力前提。`,
  );
  expect(
    native.mediaError,
    `此案例需要有 ${fileName} 原生解碼能力的 Chrome runner`,
  ).toBeNull();
  expect(native.width).toBeGreaterThan(0);
  expect(native.frames).toBeGreaterThan(2);
  expect(native.currentTime).toBeGreaterThanOrEqual(1);
  return path;
}

export async function createHostRoom(host: Page) {
  await host.getByLabel("你的暱稱").first().fill("房主");
  await host.getByRole("button", { name: "建立房間", exact: true }).click();
  const code = host.getByTestId("invite-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return code.innerText();
}

export async function joinViewer(
  viewer: Page,
  invite: string,
  name = "朋友甲",
) {
  await viewer.goto("/");
  const join = viewer
    .locator("form")
    .filter({ has: viewer.getByLabel("邀請碼") });
  await join.getByLabel("邀請碼").fill(invite);
  await join.getByLabel("你的暱稱").fill(name);
  await submitJoin(
    viewer,
    join.getByRole("button", { name: "加入", exact: true }),
  );
  await beginWatching(viewer);
}

export async function installCaptureAudit(page: Page) {
  await page.addInitScript(() => {
    const scope = window as GlobalWithMediaStreams;
    const audit: Bug004Audit = {
      selection: "",
      captures: [],
      generators: [],
    };
    scope.bug004Audit = audit;

    const proto = HTMLVideoElement.prototype as CaptureStreamVideoProto;
    const originalCapture = proto.captureStream;
    if (originalCapture) {
      proto.captureStream = function (this: HTMLVideoElement) {
        const stream = originalCapture.call(this);
        const tracks = new Map<MediaStreamTrack, string>(
          stream.getTracks().map((track) => [track, audit.selection]),
        );
        stream.addEventListener("addtrack", (event) => {
          tracks.set(event.track, audit.selection);
        });
        audit.captures.push({ tracks });
        return stream;
      };
    }

    const OriginalGenerator = scope.MediaStreamTrackGenerator;
    if (OriginalGenerator) {
      scope.MediaStreamTrackGenerator = new Proxy(OriginalGenerator, {
        construct(target, args) {
          const track = Reflect.construct(target, args) as GeneratorTrackLike;
          audit.generators.push(track);
          return track;
        },
      });
    }
  });
}

export function readCaptureAudit(page: Page) {
  return page.evaluate(() => {
    const audit = (window as GlobalWithMediaStreams).bug004Audit;
    if (!audit) return { captures: [], generators: [] };
    return {
      captures: audit.captures.map((entry) =>
        [...entry.tracks.entries()].map(([track, selection]) => ({
          id: track.id,
          kind: track.kind,
          state: track.readyState,
          selection,
        })),
      ),
      generators: audit.generators.map((track) => ({
        id: track.id,
        state: track.readyState,
      })),
    };
  });
}

export async function installFirstFrameGate(page: Page) {
  await page.addInitScript(() => {
    const scope = window as GlobalWithMediaStreams;
    let resolveGate: (() => void) | null = null;
    let gatePromise = Promise.resolve();
    const generators: GeneratorTrackLike[] = [];

    const gate: Bug004Gate = {
      armed: false,
      held: false,
      generators,
      arm() {
        gate.armed = true;
        gate.held = false;
        gatePromise = new Promise<void>((resolve) => {
          resolveGate = resolve;
        });
      },
      release() {
        gate.armed = false;
        resolveGate?.();
        resolveGate = null;
      },
    };
    scope.bug004Gate = gate;

    const OriginalGenerator = scope.MediaStreamTrackGenerator;
    if (OriginalGenerator) {
      scope.MediaStreamTrackGenerator = new Proxy(OriginalGenerator, {
        construct(target, args) {
          const track = Reflect.construct(target, args) as GeneratorTrackLike;
          generators.push(track);
          return track;
        },
      });
    }

    const originalPipeTo = ReadableStream.prototype.pipeTo;
    ReadableStream.prototype.pipeTo = function <R>(
      this: ReadableStream<R>,
      destination: WritableStream<R>,
      options?: StreamPipeOptions,
    ) {
      const isGeneratorWritable = generators.some(
        (track) =>
          (track.writable as unknown as WritableStream<R>) === destination,
      );
      if (!isGeneratorWritable) {
        return originalPipeTo.call(this, destination, options);
      }

      const gated = (this as unknown as ReadableStream<VideoFrame>).pipeThrough(
        new TransformStream<VideoFrame, VideoFrame>({
          async transform(frame, controller) {
            if (gate.armed) {
              gate.held = true;
              const signal = options?.signal;
              await new Promise<void>((resolve) => {
                if (!gate.armed || signal?.aborted) {
                  resolve();
                  return;
                }
                const finish = () => {
                  signal?.removeEventListener("abort", finish);
                  resolve();
                };
                signal?.addEventListener("abort", finish, { once: true });
                void gatePromise.then(finish);
              });
              if (signal?.aborted) {
                frame.close();
                controller.terminate();
                return;
              }
            }
            controller.enqueue(frame);
          },
        }),
      );
      return originalPipeTo.call(
        gated as unknown as ReadableStream<R>,
        destination,
        options,
      );
    };
  });
}
