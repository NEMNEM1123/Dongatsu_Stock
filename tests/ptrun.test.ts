import { describe, expect, it } from "vitest";
import { calcAnswer, calcProblems, fryReadyMs, memorySeq, memoryShowMs, memoryLength, matchLayout } from "../shared/parttime";
import { finishEarly, flip, isExpired, pull, remainMs, settle, startRun, submitCalc, submitMemory, viewData } from "../shared/ptrun";
import { RULES } from "../shared/rules";

const T0 = 1_000_000;
const G = RULES.PUZZLE_GRACE_MS;

describe("알바 근무: 계산", () => {
  const run = startRun("calc", {}, 5, T0);
  const answers = (n: number) => calcProblems(5, run.n).slice(0, n).map(calcAnswer);

  it("문제 수는 근무 시간으로 정해지고, 정답을 내면 수입", () => {
    expect(run.n).toBe(Math.floor((RULES.PT_JOBS.calc.shiftSec * 1000) / RULES.PT_CALC_MIN_ANSWER_MS));
    const s = submitCalc(run, answers(20), T0 + 30_000);
    expect(s).toMatchObject({ k: "end", end: { pay: 20 * run.unit, reason: "done", stats: { correct: 20, wrong: 0 } } });
  });

  it("시간 초과·너무 빠름·잘못된 형식은 수입 0", () => {
    const late = submitCalc(run, answers(5), T0 + run.shift + G + 1);
    expect(late).toMatchObject({ k: "end", end: { pay: 0, reason: "invalid" } });
    const fast = submitCalc(run, answers(30), T0 + 1000);
    expect(fast).toMatchObject({ k: "end", end: { pay: 0, reason: "invalid" } });
    expect(submitCalc(run, "x" as never, T0).k).toBe("invalid");
  });

  it("다른 직종 run에는 쓸 수 없음", () => {
    expect(submitCalc(startRun("fry", {}, 1, T0), [1], T0).k).toBe("invalid");
  });

  it("화면에 보내는 문제에는 정답이 없고 업그레이드로 문제 수가 늘어남", () => {
    const v = viewData(run, T0, memorySeq);
    expect(JSON.stringify(v)).not.toContain("answer");
    expect(startRun("calc", { time: 10 }, 5, T0).n).toBeGreaterThan(run.n);
  });
});

describe("알바 근무: 순서 기억", () => {
  const start = startRun("memory", {}, 9, T0);

  it("시작은 1라운드, 시간 제한은 라운드마다", () => {
    expect(start).toMatchObject({ step: 1, shift: 0 });
    expect(isExpired(start, T0 + memoryShowMs(1) + 5_000)).toBe(false);
    expect(isExpired(start, T0 + 999_999)).toBe(true);
  });

  const good = (r: ReturnType<typeof startRun>, now: number) => submitMemory(r, memorySeq(r.seed, r.step), now + memoryShowMs(r.step) + memoryLength(r.step) * 120 + 400);

  it("연속으로 성공하면 라운드별 수입이 쌓이고 마지막 라운드에서 끝", () => {
    let r = start;
    let now = T0;
    let total = 0;
    for (let round = 1; round < RULES.PT_MEMORY_MAX_ROUND; round++) {
      const s = good(r, now);
      if (s.k !== "go") throw new Error(`round ${round}: ${s.k}`);
      total += r.unit * round;
      expect(s.run.earned).toBe(total);
      expect(s.run.step).toBe(round + 1);
      now = s.run.stepAt;
      r = s.run;
    }
    const last = good(r, now);
    expect(last).toMatchObject({ k: "end", end: { reason: "done", pay: total + r.unit * RULES.PT_MEMORY_MAX_ROUND } });
  });

  it("틀리면 그때까지의 수입만 받고 끝", () => {
    const s1 = good(start, T0);
    if (s1.k !== "go") throw new Error("unreachable");
    const wrong = submitMemory(s1.run, memorySeq(9, 2).map((v) => (v + 1) % 4), s1.run.stepAt + memoryShowMs(2) + 2000);
    expect(wrong).toMatchObject({ k: "end", end: { reason: "fail", pay: start.unit, stats: { rounds: 1 } } });
  });

  it("너무 빠른 제출은 오류로 돌려주고 라운드는 그대로", () => {
    expect(submitMemory(start, memorySeq(9, 1), T0 + 100)).toMatchObject({ k: "invalid" });
  });

  it("시간 초과 제출은 실패로 끝, 정수가 아닌 입력은 거절", () => {
    const late = submitMemory(start, memorySeq(9, 1), T0 + 999_999);
    expect(late).toMatchObject({ k: "end", end: { reason: "fail", pay: 0 } });
    expect(submitMemory(start, [1.5, 2, 3], T0).k).toBe("invalid");
  });
});

describe("알바 근무: 짝 맞추기", () => {
  const start = startRun("match", {}, 11, T0);
  const layout = matchLayout(11);
  const pos = (sym: number) => layout.flatMap((v, i) => (v === sym ? [i] : []));

  it("카드 정보는 뒤집은 것만 화면에 나감", () => {
    expect(viewData(start, T0, memorySeq).match!.cards.every((c) => c === -1)).toBe(true);
    const f = flip(start, 3, T0 + 1000);
    if (f.k !== "go") throw new Error("unreachable");
    const cards = viewData(f.run, T0 + 1000, memorySeq).match!.cards;
    expect(cards.filter((c) => c !== -1)).toEqual([layout[3]]);
  });

  it("너무 빠른 연속 뒤집기는 거절", () => {
    const f = flip(start, 3, T0 + 1000);
    if (f.k !== "go") throw new Error("unreachable");
    expect(flip(f.run, 4, T0 + 1000 + RULES.PT_MATCH_MIN_FLIP_MS - 1).k).toBe("invalid");
    expect(flip(f.run, 4, T0 + 1000 + RULES.PT_MATCH_MIN_FLIP_MS).k).not.toBe("invalid");
  });

  it("전부 맞추면 끝나고 남은 시간 보너스, 중간에 그만두면 맞춘 만큼만", () => {
    let r = start;
    let now = T0 + 500;
    for (let sym = 0; sym < RULES.PT_MATCH_PAIRS; sym++) {
      const [a, b] = pos(sym);
      let s = flip(r, a!, now);
      if (s.k !== "go") throw new Error("unreachable");
      now += 300;
      s = flip(s.run, b!, now);
      if (sym < RULES.PT_MATCH_PAIRS - 1) {
        if (s.k !== "go") throw new Error("unreachable");
        r = s.run;
        now += 300;
      } else {
        expect(s.k).toBe("end");
        if (s.k === "end") {
          const base = RULES.PT_MATCH_PAIRS * r.unit;
          expect(s.end.pay).toBeGreaterThan(base); // 시간이 남았으니 보너스
          expect(s.end).toMatchObject({ reason: "done", stats: { found: RULES.PT_MATCH_PAIRS } });
        }
      }
    }
    // 3쌍만 맞추고 그만두기
    let q = start;
    let t = T0 + 500;
    for (let sym = 0; sym < 3; sym++) {
      const [a, b] = pos(sym);
      const s1 = flip(q, a!, t);
      if (s1.k !== "go") throw new Error("unreachable");
      t += 300;
      const s2 = flip(s1.run, b!, t);
      if (s2.k !== "go") throw new Error("unreachable");
      q = s2.run;
      t += 300;
    }
    expect(finishEarly(q, t)).toMatchObject({ reason: "early", pay: 3 * q.unit });
  });

  it("잘못된 카드는 거절", () => {
    expect(flip(start, 99, T0 + 1000).k).toBe("invalid");
    expect(flip(start, -1, T0 + 1000).k).toBe("invalid");
  });
});

describe("알바 근무: 튀기기", () => {
  const start = startRun("fry", {}, 21, T0);
  const ready0 = fryReadyMs(21, 0);

  it("완성 시각에 건지면 완벽, 다음 튀김이 시작됨", () => {
    const s = pull(start, ready0, T0 + ready0 + 100);
    expect(s).toMatchObject({ k: "go", info: { kind: "fry", grade: "perfect", pay: start.unit } });
    if (s.k === "go") expect(s.run).toMatchObject({ step: 1, earned: start.unit, stepAt: T0 + ready0 + 100 });
  });

  it("너무 일찍 건지면 실패, 조작된 시간은 수입 0", () => {
    expect(pull(start, 300, T0 + 400)).toMatchObject({ info: { grade: "miss", pay: 0 } });
    expect(pull(start, ready0, T0 + 100)).toMatchObject({ info: { grade: "cheat", pay: 0 } });
  });

  it("지금 튀기는 번호의 완성 시각이 화면에 내려가지만 다음 것은 모름", () => {
    const v = viewData(start, T0, memorySeq).fry!;
    expect(v).toEqual({ index: 0, readyMs: ready0 });
  });

  it("근무 시간이 지나면 만료, 표시 시간은 여유를 포함하지 않음", () => {
    expect(isExpired(start, T0 + start.shift + G)).toBe(false);
    expect(isExpired(start, T0 + start.shift + G + 1)).toBe(true);
    expect(remainMs(start, T0 + start.shift + 5000)).toBe(0);
    expect(settle({ ...start, earned: 1400 }, T0, "time")).toMatchObject({ pay: 1400, reason: "time" });
  });
});
