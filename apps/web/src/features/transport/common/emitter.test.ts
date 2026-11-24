import { describe, expect, it, vi } from "vitest";
import { Emitter } from "./emitter";

type Events = {
  value: [number];
  pair: [{ memberId: string; state: string }];
};

describe("Emitter", () => {
  it("delivers events and unsubscribes", () => {
    const emitter = new Emitter<Events>();
    const handler = vi.fn();
    const off = emitter.on("value", handler);

    emitter.emit("value", 1);
    emitter.emit("value", 2);
    off();
    emitter.emit("value", 3);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(2);
  });

  it("supports object payloads", () => {
    const emitter = new Emitter<Events>();
    const handler = vi.fn();
    emitter.on("pair", handler);
    emitter.emit("pair", { memberId: "m1", state: "playing" });
    expect(handler).toHaveBeenCalledWith({ memberId: "m1", state: "playing" });
  });

  it("removeAll clears every listener", () => {
    const emitter = new Emitter<Events>();
    const handler = vi.fn();
    emitter.on("value", handler);
    emitter.removeAll();
    emitter.emit("value", 1);
    expect(handler).not.toHaveBeenCalled();
  });
});
