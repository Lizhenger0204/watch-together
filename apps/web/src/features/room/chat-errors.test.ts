import { describe, expect, test } from "vitest";
import { ApiError } from "../../lib/api";
import { SignalDisconnectedError, SignalTimeoutError } from "../../lib/signal";
import { CHAT_NOT_SENT, chatErrorMessage } from "./chat-errors";

describe("chatErrorMessage", () => {
  test("還沒寫入 socket 就斷線：確定沒送出", () => {
    expect(chatErrorMessage(new SignalDisconnectedError())).toBe(CHAT_NOT_SENT);
  });

  test("等 ack 時斷線或逾時：不可說成「未送出」", () => {
    for (const error of [
      new SignalDisconnectedError(true),
      new SignalTimeoutError(),
    ]) {
      const message = chatErrorMessage(error);
      expect(message).toContain("無法確認");
      expect(message).not.toBe(CHAT_NOT_SENT);
    }
  });

  test("伺服器明確拒絕：限流有專用提示", () => {
    expect(chatErrorMessage(new ApiError("RATE_LIMITED"))).toContain("太快");
  });
});
