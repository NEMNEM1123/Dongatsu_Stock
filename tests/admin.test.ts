import { describe, expect, it } from "vitest";
import { adjustCash, parseAnnounce } from "../shared/admin";
import { RULES } from "../shared/rules";

describe("전체 공지", () => {
  it("앞뒤 공백을 빼고, 빈 문구와 너무 긴 문구는 거부", () => {
    expect(parseAnnounce("  점검 예정  ")).toEqual({ ok: true, value: "점검 예정" });
    for (const bad of ["", "   ", undefined, 123, "가".repeat(RULES.ANNOUNCE_MAX_LEN + 1)]) expect(parseAnnounce(bad).ok).toBe(false);
    expect(parseAnnounce("가".repeat(RULES.ANNOUNCE_MAX_LEN)).ok).toBe(true);
  });
});

describe("현금 조정", () => {
  it("지정과 증감", () => {
    expect(adjustCash(500, "set", 1_000)).toEqual({ ok: true, value: 1_000 });
    expect(adjustCash(500, "add", 1_000)).toEqual({ ok: true, value: 1_500 });
    expect(adjustCash(500, "add", -500)).toEqual({ ok: true, value: 0 });
  });

  it("음수 결과, 상한 초과, 정수가 아닌 값, 모르는 방식은 거부", () => {
    expect(adjustCash(500, "add", -501).ok).toBe(false);
    expect(adjustCash(500, "set", -1).ok).toBe(false);
    expect(adjustCash(0, "set", RULES.ADMIN_CASH_MAX + 1).ok).toBe(false);
    expect(adjustCash(RULES.ADMIN_CASH_MAX, "add", 1).ok).toBe(false);
    for (const bad of [1.5, NaN, Infinity, "1000", null, undefined]) expect(adjustCash(500, "set", bad).ok).toBe(false);
    expect(adjustCash(500, "mul", 2).ok).toBe(false);
  });
});
