/**
 * 收看者房間層 × 真正的 relay viewer transport（T-122）：
 * WHEP 409（STREAM_NOT_LIVE）維持 waiting，下一個開播廣播再拉一次。
 */
import type { ServerMessage, ServerMessageOf } from "@project/shared";
import { describe, expect, test } from "vitest";
import { createFakePeerConnectionFactory } from "../transport/common/rtc-fake";
import { createRelayViewerTransport } from "../transport/relay";
import {
  created,
  flush,
  gather,
  ROOM,
  useRelayFakes,
} from "../transport/relay/test-fixtures";
import { ViewerSession, type ViewerSessionClient } from "./viewer-session";

const http = useRelayFakes();

const snapshot = (live: boolean): ServerMessageOf<"room:snapshot"> => ({
  type: "room:snapshot",
  room: {
    roomId: ROOM,
    locked: false,
    mode: "relay",
    quality: "standard",
    createdAt: 0,
  },
  members: [],
  stream: live
    ? { live: true, title: "電影", startedAt: 1 }
    : { live: false, title: null, startedAt: null },
  you: { memberId: "m1", role: "member" },
});

const liveBroadcast = (on: boolean): ServerMessage =>
  on
    ? { type: "stream:status", live: true, title: "電影", startedAt: 1 }
    : { type: "stream:status", live: false, title: null, startedAt: null };

function setup() {
  const handlers = new Set<(m: ServerMessage) => void>();
  const sent: Parameters<ViewerSessionClient["send"]>[0][] = [];
  const client: ViewerSessionClient = {
    onState: () => () => {},
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    send: (m) => {
      sent.push(m);
      return true;
    },
  };
  const { factory, connections } = createFakePeerConnectionFactory();
  const session = new ViewerSession({
    client,
    roomId: ROOM,
    token: "member-token",
    requestNewSocket: () => {},
    createTransport: (options) =>
      createRelayViewerTransport({
        ...options,
        createPeerConnection: factory,
        fetchIceServers: async () => [],
      }),
  });
  session.attach();
  const receive = (m: ServerMessage) => handlers.forEach((h) => h(m));
  const statuses = () =>
    sent.filter((m) => m.type === "member:status").map((m) => m.state);
  return { session, receive, connections, statuses };
}

describe("WHEP 409 → 開播廣播 → 第二次 WHEP", () => {
  test("409 維持 waiting、不顯示錯誤；下一個開播廣播重新拉一次", async () => {
    const s = setup();
    s.receive(snapshot(true));
    await gather(s.connections);
    expect(http().posts()).toHaveLength(1);
    http().lastPost().respond(409);
    await flush();
    expect(s.session.getView()).toMatchObject({
      live: true,
      state: "waiting",
      error: null,
    });
    expect(s.statuses()).not.toContain("failed");

    s.receive(liveBroadcast(true));
    await gather(s.connections);
    expect(http().posts()).toHaveLength(2);
    expect(s.session.getView().state).toBe("connecting");
    created(http().lastPost());
    await flush();
    s.connections.at(-1)!.setIceConnectionState("connected");
    expect(s.session.getView()).toMatchObject({
      state: "playing",
      error: null,
    });
  });

  test("只在 409 之後重拉一次：直播中的重複廣播不會多送 WHEP", async () => {
    const s = setup();
    s.receive(snapshot(true));
    await gather(s.connections);
    created(http().lastPost());
    await flush();
    s.receive(liveBroadcast(true));
    await flush();
    expect(http().posts()).toHaveLength(1);

    // 再遇到 409：同樣等下一個廣播，且每個廣播只拉一次。
    s.receive(liveBroadcast(false));
    s.receive(liveBroadcast(true));
    await gather(s.connections);
    http().lastPost().respond(409);
    await flush();
    expect(http().posts()).toHaveLength(2);
    s.receive(liveBroadcast(true));
    s.receive(liveBroadcast(true));
    await gather(s.connections);
    expect(http().posts()).toHaveLength(3);
  });

  test("409 之後才停播：不再重拉，下一次開播照常拉取", async () => {
    const s = setup();
    s.receive(snapshot(true));
    await gather(s.connections);
    http().lastPost().respond(409);
    await flush();
    s.receive(liveBroadcast(false));
    await flush();
    expect(http().posts()).toHaveLength(1);
    expect(s.session.getView()).toMatchObject({
      live: false,
      state: "waiting",
    });
    s.receive(liveBroadcast(true));
    await gather(s.connections);
    expect(http().posts()).toHaveLength(2);
  });

  test("其他錯誤（503）仍顯示 failed", async () => {
    const s = setup();
    s.receive(snapshot(true));
    await gather(s.connections);
    http().lastPost().respond(503);
    await flush();
    expect(s.session.getView()).toMatchObject({ state: "failed" });
    expect(s.session.getView().error?.code).toBe("RELAY_UNAVAILABLE");
  });
});
