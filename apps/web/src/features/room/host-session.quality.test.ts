import type { Quality } from "@project/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { SignalDisconnectedError, SignalTimeoutError } from "../../lib/signal";
import { QUALITY_BROADCAST_GRACE_MS } from "./host-session-quality";
import { Q, roomUpdated, setup, snapshot } from "./host-session.fixtures";

// 畫質連續調整（streaming.md §2）：房主「最後的選擇」優先，房間的廣播延遲、
// 被拒或逾時都要能回到正確的畫質，不靠重開面板。

const at = (bitrate: Quality["bitrate"]): Quality => ({
  ...Q.standard,
  bitrate,
});
const update = (bitrate: Quality["bitrate"]) =>
  `room:update quality=1080/${bitrate}/30`;

afterEach(() => vi.useRealTimers());

describe("房主的畫質請求", () => {
  test("8→10→15→8、房間廣播都還沒回來：最後的 8 一定送出，畫面一直顯示最後的選擇，最後套用 8", async () => {
    const t = setup();
    await t.goLive();
    t.log.length = 0;

    t.session.setQuality(at(10_000_000));
    t.session.setQuality(at(15_000_000));
    // 房間（廣播）仍是 8 Mbps：原版與「廣播的舊值」比較而被當成沒變更。
    t.session.setQuality(at(8_000_000));
    expect(t.log).toEqual([
      update(10_000_000),
      update(15_000_000),
      update(8_000_000),
    ]);
    expect(t.session.getView().pendingQuality).toEqual(at(8_000_000));

    // 三筆都被接受，廣播依序延遲到達：中間的舊廣播不會把畫面拉回去。
    await t.client.ackFirst(update(10_000_000));
    await t.client.ackFirst(update(15_000_000));
    await t.client.ackFirst(update(8_000_000));
    expect(t.session.getView().pendingQuality).toEqual(at(8_000_000));
    t.client.emit(roomUpdated("p2p", at(10_000_000)));
    expect(t.session.getView().pendingQuality).toEqual(at(8_000_000));
    t.client.emit(roomUpdated("p2p", at(15_000_000)));
    expect(t.session.getView().pendingQuality).toEqual(at(8_000_000));
    t.client.emit(roomUpdated("p2p", at(8_000_000)));
    expect(t.session.getView().pendingQuality).toBeNull();
    expect(t.log.at(-1)).toBe("setQuality 1080/8000000/30");
  });

  test("廣播比 ack 早到：ack 時房間已是最後的選擇，直接清掉", async () => {
    const t = setup();
    await t.goLive();
    t.session.setQuality(Q.smooth);
    t.client.emit(roomUpdated("p2p", Q.smooth));
    expect(t.session.getView().pendingQuality).toEqual(Q.smooth);
    await t.client.ack("room:update quality=720/8000000/30");
    expect(t.session.getView().pendingQuality).toBeNull();
  });

  test("鎖房等無關的 room:updated 不算畫質確認：先收過一次也不會讓之後的請求提前清掉", async () => {
    const t = setup();
    await t.goLive();
    // 鎖房的廣播先到（畫質仍是房間的 8 Mbps）。
    t.client.emit(roomUpdated("p2p", Q.standard));
    t.session.setQuality(at(10_000_000));
    await t.client.ack(update(10_000_000));
    // 畫質廣播還沒到：畫面仍顯示最後的選擇，第二條滑桿才不會拿舊值送出。
    expect(t.session.getView().pendingQuality).toEqual(at(10_000_000));
    // 又來一個不帶畫質變化的廣播（例如重新產生邀請碼）：同樣不清掉。
    t.client.emit(roomUpdated("p2p", Q.standard));
    expect(t.session.getView().pendingQuality).toEqual(at(10_000_000));
    t.client.emit(roomUpdated("p2p", at(10_000_000)));
    expect(t.session.getView().pendingQuality).toBeNull();
  });

  test("連續調整時夾雜無關廣播：只有排在隊首的畫質廣播才出列，最後一筆到了才清掉", async () => {
    const t = setup();
    await t.goLive();
    t.session.setQuality(at(10_000_000));
    t.session.setQuality(at(15_000_000));
    await t.client.ackFirst(update(10_000_000));
    await t.client.ackFirst(update(15_000_000));
    // 房主在兩次調整之間鎖房：廣播帶著當下的畫質（10 Mbps），不是隊首（先 10 後 15）時被忽略。
    t.client.emit(roomUpdated("p2p", at(10_000_000)));
    t.client.emit(roomUpdated("p2p", at(10_000_000)));
    expect(t.session.getView().pendingQuality).toEqual(at(15_000_000));
    t.client.emit(roomUpdated("p2p", at(15_000_000)));
    expect(t.session.getView().pendingQuality).toBeNull();
  });

  test("最後一筆被房間拒絕：清掉最後的選擇、顯示錯誤，面板回到房間真實的畫質", async () => {
    const t = setup();
    await t.goLive();
    t.session.setQuality(Q.smooth);
    expect(t.session.getView().pendingQuality).toEqual(Q.smooth);
    await t.client.ack(
      "room:update quality=720/8000000/30",
      new ApiError("FORBIDDEN"),
    );
    expect(t.session.getView().pendingQuality).toBeNull();
    expect(t.session.getView().error).not.toBeNull();
    // 之後再選同一檔可重新送出。
    t.session.setQuality(Q.smooth);
    expect(t.client.requests).toHaveLength(1);
  });

  test("最後一筆逾時：同樣回到真實畫質；晚到的廣播仍會套用", async () => {
    const t = setup();
    await t.goLive();
    t.session.setQuality(Q.smooth);
    await t.client.ack(
      "room:update quality=720/8000000/30",
      new SignalTimeoutError(),
    );
    expect(t.session.getView().pendingQuality).toBeNull();
    t.log.length = 0;
    t.client.emit(roomUpdated("p2p", Q.smooth));
    expect(t.log).toEqual(["setQuality 720/8000000/30"]);
  });

  test("較早的請求被拒絕，不影響仍在等待的最後選擇，也不顯示錯誤", async () => {
    const t = setup();
    await t.goLive();
    t.session.setQuality(at(10_000_000));
    t.session.setQuality(at(15_000_000));
    await t.client.ackFirst(update(10_000_000), new ApiError("FORBIDDEN"));
    expect(t.session.getView().pendingQuality).toEqual(at(15_000_000));
    expect(t.session.getView().error).toBeNull();
  });

  test("斷線：進行中的請求以斷線結束，不顯示錯誤，面板回到房間畫質", async () => {
    const t = setup();
    await t.goLive();
    t.session.setQuality(Q.smooth);
    await t.client.ack(
      "room:update quality=720/8000000/30",
      new SignalDisconnectedError(),
    );
    expect(t.session.getView().pendingQuality).toBeNull();
    expect(t.session.getView().error).toBeNull();
  });

  test("重新驗證（snapshot）使之前的請求作廢，晚到的拒絕不再顯示錯誤", async () => {
    const t = setup();
    await t.goLive();
    t.session.setQuality(Q.smooth);
    t.connect(snapshot());
    expect(t.session.getView().pendingQuality).toBeNull();
    await t.client.ack(
      "room:update quality=720/8000000/30",
      new ApiError("FORBIDDEN"),
    );
    expect(t.session.getView().error).toBeNull();
  });

  test("房間接受了卻一直沒有廣播：等一段時間後改回房間的畫質", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.goLive();
    t.session.setQuality(Q.smooth);
    await t.client.ack("room:update quality=720/8000000/30");
    expect(t.session.getView().pendingQuality).toEqual(Q.smooth);
    vi.advanceTimersByTime(QUALITY_BROADCAST_GRACE_MS);
    expect(t.session.getView().pendingQuality).toBeNull();
  });
});
