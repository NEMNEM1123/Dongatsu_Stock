import { describe, expect, it } from "vitest";
import { LATEST_PATCH_ID, PATCH_NOTES } from "../shared/patchnotes";
import { RULES } from "../shared/rules";
import { helpSections, type Block } from "../web/src/helpcontent";

const textOf = (b: Block): string =>
  "p" in b ? b.p : "ul" in b ? b.ul.join("\n") : "ol" in b ? b.ol.join("\n") : "ex" in b ? b.ex.join("\n") : "tip" in b ? b.tip : "warn" in b ? b.warn : [...b.table.head, ...b.table.rows.flat()].join("\n");

describe("패치노트", () => {
  it("id가 중복되지 않고 최신순이며 맨 앞이 최신", () => {
    const ids = PATCH_NOTES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LATEST_PATCH_ID).toBe(ids[0]);
    const dates = PATCH_NOTES.map((n) => n.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("항목이 비어 있지 않다", () => {
    for (const n of PATCH_NOTES) {
      expect(n.items.length).toBeGreaterThan(0);
      for (const it of n.items) expect(it.text.trim().length).toBeGreaterThan(5);
    }
  });
});

describe("사용법 본문", () => {
  const sections = helpSections();
  const all = sections.map((s) => `${s.title}\n${s.blocks.map(textOf).join("\n")}`).join("\n\n");

  it("구역 id가 중복되지 않는다", () => {
    const ids = sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("계산 오류로 NaN·undefined가 글에 섞이지 않는다", () => {
    expect(all).not.toMatch(/NaN|undefined|Infinity|\[object/);
  });

  it("규칙 수치가 글에 반영된다 (규칙을 바꾸면 설명도 따라간다)", () => {
    expect(all).toContain("10,000,000원"); // 시작 자금
    expect(all).toContain(`${RULES.LOTTERY_PER_DAY}장`);
    expect(all).toContain(`${RULES.RESERVE_MAX}건`);
  });

  it("레버리지 청산 폭 계산: 5배는 15%, 공매도는 1배 75%·5배 15% 상승", () => {
    expect(all).toContain("약 15% 하락");
    expect(all).toContain("약 75% 상승");
    expect(all).toContain("약 15% 상승");
  });

  it("초보자용 핵심 항목이 모두 있다", () => {
    for (const key of ["첫 거래 따라하기", "공매도", "레버리지", "예약 주문", "복권", "프레스티지", "자주 묻는 질문"]) expect(all).toContain(key);
  });
});
