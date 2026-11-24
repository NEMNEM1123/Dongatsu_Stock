import { describe, expect, it } from "vitest";
import { expectedPayout, LOTTERY_TOTAL_WEIGHT, prizeForRoll } from "../shared/lottery";
import { RULES } from "../shared/rules";

describe("복권", () => {
  it("기대값은 가격보다 낮음", () => {
    expect(expectedPayout()).toBeLessThan(RULES.LOTTERY_PRICE);
    expect(expectedPayout()).toBeGreaterThan(RULES.LOTTERY_PRICE * 0.5); // 너무 박하지도 않게
  });

  it("가중치 합이 10,000이고 모든 roll이 상금에 대응", () => {
    expect(LOTTERY_TOTAL_WEIGHT).toBe(10_000);
    for (let r = 0; r < LOTTERY_TOTAL_WEIGHT; r++) prizeForRoll(r);
    expect(() => prizeForRoll(LOTTERY_TOTAL_WEIGHT)).toThrow();
  });

  it("전체 roll을 한 번씩 돌리면 표의 가중치와 정확히 일치", () => {
    const counts = new Map<number, number>();
    for (let r = 0; r < LOTTERY_TOTAL_WEIGHT; r++) {
      const p = prizeForRoll(r);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    for (const p of RULES.LOTTERY_PRIZES) expect(counts.get(p.payout)).toBe(p.weight);
  });

  it("일일 한도와 장당 가격이 규칙대로", () => {
    expect(RULES.LOTTERY_PRICE).toBe(10_000);
    expect(RULES.LOTTERY_PER_DAY).toBe(20);
  });
});
