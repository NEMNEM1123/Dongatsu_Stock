import { describe, expect, it } from "vitest";
import { generatePuzzle, MAX_STAGE, payoutFor } from "../shared/puzzle";
import { cashOut, checkBet, isExpired, newRun, nextStage, puzzleOf, remainMs, submit, type Run } from "../shared/puzzlerun";
import { RULES } from "../shared/rules";

const solve = (run: Run) => generatePuzzle(run.seed, run.stage).solution;

describe("블록 채우기 판: 배팅 검사", () => {
  it("범위 밖·정수 아님은 거절", () => {
    expect(checkBet(RULES.PUZZLE_MIN_BET)).toBeNull();
    expect(checkBet(RULES.PUZZLE_MAX_BET)).toBeNull();
    expect(checkBet(RULES.PUZZLE_MIN_BET - 1)).not.toBeNull();
    expect(checkBet(RULES.PUZZLE_MAX_BET + 1)).not.toBeNull();
    expect(checkBet(12345.5)).not.toBeNull();
    expect(checkBet("100000")).not.toBeNull();
    expect(checkBet(NaN)).not.toBeNull();
    expect(checkBet(-5)).not.toBeNull();
  });
});

describe("블록 채우기 판: 진행", () => {
  const T0 = 1_000_000;

  it("정답을 내면 선택 대기, 배당은 깬 단계 기준", () => {
    const run = newRun(100_000, 11, T0);
    const r = submit(run, solve(run), T0 + 5000);
    expect(r.k).toBe("cleared");
    if (r.k !== "cleared") return;
    expect(r.run.phase).toBe("choice");
    expect(r.run.cleared).toBe(1);
    expect(cashOut(r.run)?.payout).toBe(payoutFor(100_000, 1));
    expect(cashOut(r.run)!.payout).toBeLessThan(100_000); // 1단계 정산은 손해
  });

  it("틀린 답은 판이 유지되고, 시간 안이면 다시 낼 수 있음", () => {
    const run = newRun(100_000, 11, T0);
    expect(submit(run, [], T0 + 1000).k).toBe("invalid");
    expect(submit(run, solve(run), T0 + 2000).k).toBe("cleared");
  });

  it("제한 시간 + 여유가 지나면 정답이어도 패배, 여유 안이면 인정", () => {
    const run = newRun(100_000, 11, T0);
    const limit = RULES.PUZZLE_STAGES[0]!.seconds * 1000;
    const okAt = T0 + limit + RULES.PUZZLE_GRACE_MS;
    expect(isExpired(run, okAt)).toBe(false);
    expect(submit(run, solve(run), okAt).k).toBe("cleared");
    const late = submit(run, solve(run), okAt + 1);
    expect(late.k).toBe("expired");
    if (late.k === "expired") expect(late.outcome).toEqual({ kind: "lost", bet: 100_000, cleared: 0, payout: 0 });
  });

  it("남은 시간은 여유를 포함하지 않고 0 아래로 내려가지 않음", () => {
    const run = newRun(100_000, 11, T0);
    const limit = RULES.PUZZLE_STAGES[0]!.seconds * 1000;
    expect(remainMs(run, T0)).toBe(limit);
    expect(remainMs(run, T0 + limit + 999_999)).toBe(0);
  });

  it("선택 대기 중에는 시간이 흘러도 만료되지 않음", () => {
    const run = newRun(100_000, 11, T0);
    const r = submit(run, solve(run), T0 + 1000);
    if (r.k !== "cleared") throw new Error("unreachable");
    expect(isExpired(r.run, T0 + 10 * 24 * 3600 * 1000)).toBe(false);
  });

  it("대기 중이 아닐 때 제출·진행·정산은 거절", () => {
    const run = newRun(100_000, 11, T0);
    expect(nextStage(run, 5, T0)).toBeNull(); // 아직 play 중
    expect(cashOut(run)).toBeNull();
    const r = submit(run, solve(run), T0 + 1000);
    if (r.k !== "cleared") throw new Error("unreachable");
    expect(submit(r.run, solve(run), T0 + 2000).k).toBe("invalid"); // choice 중 제출
  });

  it("다음 단계는 새 시드·새 시각으로 시작하고 판이 커짐", () => {
    const run = newRun(100_000, 11, T0);
    const r = submit(run, solve(run), T0 + 1000);
    if (r.k !== "cleared") throw new Error("unreachable");
    const n = nextStage(r.run, 99, T0 + 9000)!;
    expect(n).toMatchObject({ phase: "play", stage: 2, cleared: 1, seed: 99, startedAt: T0 + 9000, bet: 100_000 });
    expect(puzzleOf(n).size).toBeGreaterThan(puzzleOf(run).size);
  });

  it("끝까지 깨면 마지막 단계에서 자동 정산, 배당표 마지막 값", () => {
    let run = newRun(RULES.PUZZLE_MAX_BET, 1, T0);
    let now = T0;
    for (let s = 1; s < MAX_STAGE; s++) {
      const r = submit(run, solve(run), now + 1000);
      if (r.k !== "cleared") throw new Error(`stage ${s}: ${r.k}`);
      run = nextStage(r.run, 100 + s, now + 2000)!;
      now += 2000;
    }
    const last = submit(run, solve(run), now + 1000);
    expect(last.k).toBe("max");
    if (last.k === "max") expect(last.outcome.payout).toBe(payoutFor(RULES.PUZZLE_MAX_BET, MAX_STAGE));
  });

  it("3단계를 깬 뒤 정산하면 배팅액보다 많이 받음", () => {
    let run = newRun(100_000, 7, T0);
    for (let s = 1; s <= 3; s++) {
      const r = submit(run, solve(run), run.startedAt + 1000);
      if (r.k !== "cleared") throw new Error("unreachable");
      if (s === 3) return expect(cashOut(r.run)!.payout).toBeGreaterThan(100_000);
      run = nextStage(r.run, 50 + s, run.startedAt + 2000)!;
    }
  });
});
