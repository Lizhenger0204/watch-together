import { beforeEach, describe, expect, test } from "vitest";
import { COMPARED_CODES_MAX, comparedRooms } from "./compared-rooms";

// 「邀請碼 → 已確認不是這個碼的房間」的分頁記憶體：身份清除時淘汰，邀請碼數量有上限。

const tokens = new Map<string, string>();
const current = (roomId: string) => tokens.get(roomId) ?? null;

beforeEach(() => {
  comparedRooms.clear();
  tokens.clear();
});

describe("comparedRooms", () => {
  test("記下的房間只在憑證相同時算比對過", () => {
    tokens.set("r1", "t1");
    comparedRooms.forCode("CODE0001", current).add("r1", "t1");
    expect(comparedRooms.forCode("CODE0001", current).has("r1", "t1")).toBe(
      true,
    );
    expect(comparedRooms.forCode("CODE0001", current).has("r1", "t2")).toBe(
      false,
    );
  });

  test("身份清除或憑證換掉後，所有邀請碼底下的對應項都被淘汰", () => {
    tokens.set("r1", "t1").set("r2", "t2");
    for (const code of ["CODE0001", "CODE0002"]) {
      const compared = comparedRooms.forCode(code, current);
      compared.add("r1", "t1");
      compared.add("r2", "t2");
    }
    tokens.delete("r1"); // 例如被踢、4401 後清除
    tokens.set("r2", "t2-new"); // 重新加入換了新憑證
    comparedRooms.forCode("CODE0003", current);
    expect(comparedRooms.entries()).toEqual([]);
  });

  test("forget：明確清除某房身份時立刻淘汰", () => {
    tokens.set("r1", "t1").set("r2", "t2");
    const compared = comparedRooms.forCode("CODE0001", current);
    compared.add("r1", "t1");
    compared.add("r2", "t2");
    comparedRooms.forget("r1");
    expect(comparedRooms.entries()).toEqual([["CODE0001", ["r2"]]]);
  });

  test("最多保留固定數量的邀請碼，淘汰最久沒用的", () => {
    tokens.set("r1", "t1");
    const codes = Array.from(
      { length: COMPARED_CODES_MAX + 2 },
      (_, i) => `CODE${String(i).padStart(4, "0")}`,
    );
    const remember = (code: string) =>
      comparedRooms.forCode(code, current).add("r1", "t1");
    codes.slice(0, COMPARED_CODES_MAX).forEach(remember);
    // 第一個碼最近又用過：保留，改淘汰第二、第三個。
    comparedRooms.forCode(codes[0]!, current);
    codes.slice(COMPARED_CODES_MAX).forEach(remember);
    const kept = comparedRooms.entries().map(([code]) => code);
    expect(kept).toHaveLength(COMPARED_CODES_MAX);
    expect(kept).toContain(codes[0]);
    expect(kept).not.toContain(codes[1]);
    expect(kept).not.toContain(codes[2]);
  });
});
