// 즉석 복권: 상금표는 rules.ts에 있고, 추첨(난수)은 서버에서만 한다.

import { RULES } from "./rules";

export const LOTTERY_TOTAL_WEIGHT: number = RULES.LOTTERY_PRIZES.reduce((s, p) => s + p.weight, 0);

/** roll(0 이상 TOTAL 미만 정수)에 해당하는 상금(원). 표 순서대로 가중치를 누적해 찾는다. */
export function prizeForRoll(roll: number): number {
  let acc = 0;
  for (const p of RULES.LOTTERY_PRIZES) {
    acc += p.weight;
    if (roll < acc) return p.payout;
  }
  throw new Error(`roll out of range: ${roll}`);
}

/** 1장당 기대 상금(원) */
export function expectedPayout(): number {
  return RULES.LOTTERY_PRIZES.reduce((s, p) => s + (p.payout * p.weight) / LOTTERY_TOTAL_WEIGHT, 0);
}

/** 화면 표시용 확률(%) */
export const prizeOdds = (weight: number): number => (weight / LOTTERY_TOTAL_WEIGHT) * 100;
