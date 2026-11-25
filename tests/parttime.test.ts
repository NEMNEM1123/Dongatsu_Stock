import { describe, expect, it } from "vitest";
import {
  calcAnswer, calcProblemCount, calcProblems, calcScore, flipCard, fryPay, fryReadyMs, judgeFry, judgeMemory,
  matchLayout, matchPay, memoryInputMs, memoryLength, memoryRoundPay, memorySeq, memoryShowMs, newMatch, shiftMs,
  unitPay, upgradeCost, JOB_IDS, type Levels, type MatchState,
} from "../shared/parttime";
import { RULES } from "../shared/rules";

describe("알바: 업그레이드", () => {
  it("레벨이 오를수록 비용이 늘고 만렙이면 살 수 없음", () => {
    for (const u of RULES.PT_UPGRADES) {
      let prev = 0;
      for (let lv = 0; lv < u.max; lv++) {
        const c = upgradeCost(u.id, lv)!;
        expect(c).toBeGreaterThan(prev);
        expect(c % 100).toBe(0);
        prev = c;
      }
      expect(upgradeCost(u.id, u.max)).toBeNull();
      expect(upgradeCost(u.id, -1)).toBeNull();
    }
  });

  it("첫 업그레이드는 알바 몇 번이면 살 수 있는 가격", () => {
    // 첫 한 번의 근무(완벽 기준)로 모아지는 금액 안쪽이어야 0원에서도 성장할 수 있다
    const perfectShift = RULES.PT_JOBS.calc.unit * 25; // 계산 알바 25문제 정답 정도
    for (const u of RULES.PT_UPGRADES) expect(upgradeCost(u.id, 0)!).toBeLessThanOrEqual(perfectShift * 7);
  });

  it("수입은 시급·직종 업그레이드가 곱해짐", () => {
    expect(unitPay("calc", {})).toBe(RULES.PT_JOBS.calc.unit);
    const lv: Levels = { wage: 10, calc: 4 };
    expect(unitPay("calc", lv)).toBe(Math.floor(RULES.PT_JOBS.calc.unit * 2 * 1.6));
    expect(unitPay("fry", lv)).toBe(Math.floor(RULES.PT_JOBS.fry.unit * 2)); // 다른 직종 도구는 영향 없음
  });

  it("근무 시간은 시간 업그레이드로 늘고, 시간 제한 없는 알바는 0", () => {
    expect(shiftMs("calc", {})).toBe(RULES.PT_JOBS.calc.shiftSec * 1000);
    expect(shiftMs("calc", { time: 2 })).toBe((RULES.PT_JOBS.calc.shiftSec + 6) * 1000);
    expect(shiftMs("memory", { time: 10 })).toBe(0);
  });

  it("모든 직종에 같은 이름의 업그레이드가 있음", () => {
    for (const j of JOB_IDS) expect(RULES.PT_UPGRADES.some((u) => u.id === j)).toBe(true);
  });
});

describe("알바: 계산", () => {
  it("같은 시드는 같은 문제, 답은 항상 0 이상 정수", () => {
    expect(calcProblems(5, 40)).toEqual(calcProblems(5, 40));
    for (let seed = 1; seed <= 50; seed++) {
      for (const p of calcProblems(seed, 60)) {
        const a = calcAnswer(p);
        expect(Number.isInteger(a) && a >= 0).toBe(true);
      }
    }
  });

  it("문제 수는 근무 시간과 최소 풀이 시간으로 정해짐", () => {
    expect(calcProblemCount({})).toBe(Math.floor((RULES.PT_JOBS.calc.shiftSec * 1000) / RULES.PT_CALC_MIN_ANSWER_MS));
  });

  const shift = RULES.PT_JOBS.calc.shiftSec * 1000;
  const ps = calcProblems(9, 60);
  const right = (n: number) => ps.slice(0, n).map(calcAnswer);

  it("정답은 unit씩, 오답은 절반씩 깎고 0 아래로 내려가지 않음", () => {
    const r = calcScore(ps, [...right(10)], 20_000, 300, shift);
    expect(r).toMatchObject({ correct: 10, wrong: 0, pay: 3000, valid: true });
    const mixed = right(10).map((a, i) => (i < 4 ? a + 1 : a)); // 4개 오답
    expect(calcScore(ps, mixed, 20_000, 300, shift)).toMatchObject({ correct: 6, wrong: 4, pay: 6 * 300 - 4 * 150 });
    const allWrong = right(5).map((a) => a + 1);
    expect(calcScore(ps, allWrong, 20_000, 300, shift).pay).toBe(0);
  });

  it("건너뛴 문제는 정답도 오답도 아님", () => {
    const answers = [...right(3), null, null] as (number | null)[];
    expect(calcScore(ps, answers, 10_000, 300, shift)).toMatchObject({ correct: 3, wrong: 0 });
  });

  it("너무 빠른 제출·너무 늦은 제출·문제 수 초과는 무효", () => {
    expect(calcScore(ps, right(20), 20 * RULES.PT_CALC_MIN_ANSWER_MS - 1, 300, shift).valid).toBe(false);
    expect(calcScore(ps, right(20), 20 * RULES.PT_CALC_MIN_ANSWER_MS, 300, shift).valid).toBe(true);
    expect(calcScore(ps, right(5), shift + RULES.PUZZLE_GRACE_MS + 1, 300, shift).valid).toBe(false);
    expect(calcScore(ps.slice(0, 5), right(6), 20_000, 300, shift).valid).toBe(false);
    expect(calcScore(ps, right(5), 99999999, 300, shift).pay).toBe(0);
  });

  it("조작된 값(NaN, 문자열)은 오답", () => {
    const answers = [NaN, "7" as unknown as number, Infinity];
    expect(calcScore(ps, answers, 10_000, 300, shift)).toMatchObject({ correct: 0, wrong: 3 });
  });
});

describe("알바: 순서 기억", () => {
  it("라운드마다 길이가 늘고 같은 시드·라운드면 같은 순서", () => {
    for (let r = 1; r <= RULES.PT_MEMORY_MAX_ROUND; r++) {
      const s = memorySeq(77, r);
      expect(s.length).toBe(memoryLength(r));
      expect(s.every((v) => v >= 0 && v < RULES.PT_MEMORY_MENU)).toBe(true);
      expect(memorySeq(77, r)).toEqual(s);
    }
    expect(memorySeq(77, 3)).not.toEqual(memorySeq(78, 3));
  });

  const ok = (r: number, t: number) => judgeMemory(5, r, memorySeq(5, r), t);
  it("정답·오답·시간 판정", () => {
    const r = 3;
    const fine = memoryShowMs(r) + memoryLength(r) * 120 + 500;
    expect(ok(r, fine)).toBe("ok");
    expect(judgeMemory(5, r, memorySeq(5, r).map((v) => (v + 1) % 4), fine)).toBe("wrong");
    expect(judgeMemory(5, r, memorySeq(5, r).slice(1), fine)).toBe("wrong"); // 길이 부족
    expect(ok(r, memoryShowMs(r) + memoryInputMs(r) + RULES.PUZZLE_GRACE_MS)).toBe("ok");
    expect(ok(r, memoryShowMs(r) + memoryInputMs(r) + RULES.PUZZLE_GRACE_MS + 1)).toBe("timeout");
    expect(ok(r, 100)).toBe("toofast"); // 순서를 다 보여 주기도 전에 제출
  });

  it("라운드 수입은 라운드 번호에 비례", () => {
    expect(memoryRoundPay(1, 800)).toBe(800);
    expect(memoryRoundPay(5, 800)).toBe(4000);
  });
});

describe("알바: 짝 맞추기", () => {
  it("카드는 모든 그림이 정확히 두 장씩이고 시드가 같으면 같은 배치", () => {
    const l = matchLayout(3);
    expect(l.length).toBe(RULES.PT_MATCH_PAIRS * 2);
    for (let s = 0; s < RULES.PT_MATCH_PAIRS; s++) expect(l.filter((x) => x === s).length).toBe(2);
    expect(matchLayout(3)).toEqual(l);
    expect(matchLayout(4)).not.toEqual(l);
  });

  const positions = (layout: number[], sym: number): [number, number] => {
    const idx = layout.map((v, i) => (v === sym ? i : -1)).filter((i) => i >= 0);
    return [idx[0]!, idx[1]!];
  };

  it("짝이 맞으면 match, 틀리면 miss(둘 다 덮임), 첫 장은 first", () => {
    let s: MatchState = newMatch(11);
    const [a, b] = positions(s.layout, 0);
    let r = flipCard(s, a);
    expect(r.result.kind).toBe("first");
    s = r.state;
    r = flipCard(s, b);
    expect(r.result).toMatchObject({ kind: "match", symbol: 0 });
    s = r.state;
    expect(s).toMatchObject({ found: 1, open: null, flips: 2 });
    expect(s.matched[a] && s.matched[b]).toBe(true);

    const [c] = positions(s.layout, 1);
    const [d] = positions(s.layout, 2);
    s = flipCard(s, c).state;
    r = flipCard(s, d);
    expect(r.result.kind).toBe("miss");
    expect(r.state).toMatchObject({ open: null, found: 1 });
  });

  it("잘못된 뒤집기는 거절: 범위 밖·이미 맞춘 카드·같은 카드 두 번", () => {
    let s = newMatch(11);
    expect(flipCard(s, -1).result.kind).toBe("invalid");
    expect(flipCard(s, 99).result.kind).toBe("invalid");
    expect(flipCard(s, 1.5).result.kind).toBe("invalid");
    s = flipCard(s, 0).state;
    expect(flipCard(s, 0).result.kind).toBe("invalid");
    const [a, b] = positions(s.layout, s.layout[0]!);
    s = flipCard(s, a === 0 ? b : a).state; // 짝 맞춤
    expect(flipCard(s, 0).result.kind).toBe("invalid"); // 이미 맞춘 카드
  });

  it("끝까지 맞추면 짝 수가 전부 채워지고, 순서대로 하면 최소 2×짝 번에 끝남", () => {
    let s = newMatch(21);
    for (let sym = 0; sym < RULES.PT_MATCH_PAIRS; sym++) {
      const [a, b] = positions(s.layout, sym);
      s = flipCard(flipCard(s, a).state, b).state;
    }
    expect(s.found).toBe(RULES.PT_MATCH_PAIRS);
    expect(s.flips).toBe(RULES.PT_MATCH_PAIRS * 2);
  });

  it("수입: 맞춘 만큼, 전부 맞추면 남은 시간 보너스, 시간이 없으면 보너스 0", () => {
    const shift = 60_000;
    expect(matchPay(3, 8, 10_000, shift, 1000)).toBe(3000);
    expect(matchPay(8, 8, 0, shift, 1000)).toBe(8000);
    expect(matchPay(8, 8, 30_000, shift, 1000)).toBe(8000 + Math.floor(8000 * RULES.PT_MATCH_TIME_BONUS * 0.5));
    expect(matchPay(8, 8, 999_999, shift, 1000)).toBe(8000 + Math.floor(8000 * RULES.PT_MATCH_TIME_BONUS)); // 비율은 1을 넘지 않음
  });
});

describe("알바: 돈까스 튀기기", () => {
  it("완성 시각은 범위 안이고 시드·번호가 같으면 같음", () => {
    for (let n = 0; n < 100; n++) {
      const t = fryReadyMs(8, n);
      expect(t).toBeGreaterThanOrEqual(RULES.PT_FRY_READY_MIN_MS);
      expect(t).toBeLessThanOrEqual(RULES.PT_FRY_READY_MAX_MS);
      expect(fryReadyMs(8, n)).toBe(t);
    }
    expect(new Set(Array.from({ length: 30 }, (_, n) => fryReadyMs(8, n))).size).toBeGreaterThan(10);
  });

  const ready = 2500;
  it("완성 시각에 가까울수록 높은 등급", () => {
    expect(judgeFry(ready, ready, ready + 100)).toBe("perfect");
    expect(judgeFry(ready, ready - RULES.PT_FRY_PERFECT_MS, ready)).toBe("perfect");
    expect(judgeFry(ready, ready + RULES.PT_FRY_PERFECT_MS + 1, ready + 400)).toBe("good");
    expect(judgeFry(ready, ready - RULES.PT_FRY_GOOD_MS, ready)).toBe("good");
    expect(judgeFry(ready, ready - RULES.PT_FRY_GOOD_MS - 1, ready)).toBe("miss");
    expect(judgeFry(ready, ready + 2000, ready + 2100)).toBe("miss");
  });

  it("화면 시간이 서버 시간보다 길거나 지연 한도보다 훨씬 짧으면 무효", () => {
    expect(judgeFry(ready, ready, ready - 500)).toBe("cheat"); // 서버는 아직 덜 지났는데 이미 건졌다고 함
    expect(judgeFry(ready, ready, ready + RULES.PT_FRY_MAX_LAG_MS + 1)).toBe("cheat"); // 서버 시간만 한참 지남(미리 쏜 요청)
    expect(judgeFry(ready, ready, ready + RULES.PT_FRY_MAX_LAG_MS)).toBe("perfect");
    expect(judgeFry(ready, NaN, ready)).toBe("cheat");
    expect(judgeFry(ready, -5, ready)).toBe("cheat");
  });

  it("수입: 완벽 unit, 괜찮음 절반, 나머지 0", () => {
    expect(fryPay("perfect", 700)).toBe(700);
    expect(fryPay("good", 700)).toBe(350);
    expect(fryPay("miss", 700)).toBe(0);
    expect(fryPay("cheat", 700)).toBe(0);
  });
});

describe("알바: 수입 규모 점검", () => {
  it("한 번의 근무로 벌 수 있는 최대치가 시작 자금보다 훨씬 작음", () => {
    const calc = calcProblemCount({}) * RULES.PT_JOBS.calc.unit;
    const memory = Array.from({ length: RULES.PT_MEMORY_MAX_ROUND }, (_, i) => memoryRoundPay(i + 1, RULES.PT_JOBS.memory.unit)).reduce((a, b) => a + b, 0);
    const match = matchPay(RULES.PT_MATCH_PAIRS, RULES.PT_MATCH_PAIRS, shiftMs("match", {}), shiftMs("match", {}), RULES.PT_JOBS.match.unit);
    const fry = Math.floor(shiftMs("fry", {}) / RULES.PT_FRY_READY_MIN_MS) * RULES.PT_JOBS.fry.unit;
    for (const v of [calc, memory, match, fry]) expect(v).toBeLessThan(RULES.START_CASH / 100);
  });
});
