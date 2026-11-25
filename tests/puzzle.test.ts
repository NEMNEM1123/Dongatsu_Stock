import { describe, expect, it } from "vitest";
import {
  deadlineMs,
  generatePuzzle,
  MAX_STAGE,
  multFor,
  normalize,
  payoutFor,
  placedCells,
  rotate,
  verifySolution,
  type Cell,
  type Placement,
} from "../shared/puzzle";
import { RULES } from "../shared/rules";

const connected = (cells: readonly Cell[]): boolean => {
  const key = (c: Cell) => `${c[0]},${c[1]}`;
  const set = new Set(cells.map(key));
  const seen = new Set<string>([key(cells[0]!)]);
  const stack: Cell[] = [cells[0]!];
  while (stack.length) {
    const [r, c] = stack.pop()!;
    for (const nb of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]] as Cell[]) {
      const k = key(nb);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        stack.push(nb);
      }
    }
  }
  return seen.size === cells.length;
};

describe("블록 채우기: 모양", () => {
  it("네 번 돌리면 제자리", () => {
    const l: Cell[] = [[0, 0], [1, 0], [2, 0], [2, 1]];
    expect(rotate(l, 4)).toEqual(normalize(l));
    expect(rotate(rotate(l, 1), 3)).toEqual(normalize(l));
  });

  it("L자를 시계 방향으로 한 번 돌린 모양", () => {
    const l: Cell[] = [[0, 0], [1, 0], [2, 0], [2, 1]];
    // ■■■
    // ■□□   (시계 방향 90도)
    expect(rotate(l, 1)).toEqual([[0, 0], [0, 1], [0, 2], [1, 0]]);
  });
});

describe("블록 채우기: 생성", () => {
  it("모든 단계·여러 시드에서 정답이 검증을 통과하고 칸 수가 맞음", () => {
    for (let stage = 1; stage <= MAX_STAGE; stage++) {
      for (let seed = 1; seed <= 60; seed++) {
        const { puzzle, solution } = generatePuzzle(seed * 7919 + stage, stage);
        expect(verifySolution(puzzle, solution)).toEqual({ ok: true });
        const total = puzzle.pieces.reduce((s, p) => s + p.cells.length, 0);
        expect(total).toBe(puzzle.size * puzzle.size);
      }
    }
  });

  it("조각은 모두 연결돼 있고 최소 크기를 지킴", () => {
    for (let stage = 1; stage <= MAX_STAGE; stage++) {
      const cfg = RULES.PUZZLE_STAGES[stage - 1]!;
      for (let seed = 1; seed <= 40; seed++) {
        for (const p of generatePuzzle(seed, stage).puzzle.pieces) {
          expect(connected(p.cells)).toBe(true);
          expect(p.cells.length).toBeGreaterThanOrEqual(cfg.minPiece);
        }
      }
    }
  });

  it("같은 시드면 같은 판, 다른 시드면 대체로 다른 판", () => {
    expect(generatePuzzle(123, 4)).toEqual(generatePuzzle(123, 4));
    expect(generatePuzzle(123, 4).puzzle).not.toEqual(generatePuzzle(124, 4).puzzle);
  });

  it("단계가 오를수록 판이 커지고 시간이 늘어남", () => {
    for (let s = 2; s <= MAX_STAGE; s++) {
      expect(generatePuzzle(1, s).puzzle.size).toBeGreaterThan(generatePuzzle(1, s - 1).puzzle.size);
      expect(generatePuzzle(1, s).puzzle.seconds).toBeGreaterThan(generatePuzzle(1, s - 1).puzzle.seconds);
    }
  });

  it("없는 단계는 오류", () => {
    expect(() => generatePuzzle(1, 0)).toThrow();
    expect(() => generatePuzzle(1, MAX_STAGE + 1)).toThrow();
  });
});

describe("블록 채우기: 검증", () => {
  const { puzzle, solution } = generatePuzzle(42, 3);
  const withFirst = (patch: Partial<Placement>): Placement[] =>
    solution.map((p, i) => (i === 0 ? { ...p, ...patch } : p));

  it("정답이 아닌 제출은 모두 거절", () => {
    expect(verifySolution(puzzle, solution.slice(1)).ok).toBe(false); // 조각 누락
    expect(verifySolution(puzzle, [...solution, solution[0]!]).ok).toBe(false); // 개수 초과
    expect(verifySolution(puzzle, solution.map((p, i) => (i === 1 ? { ...p, id: solution[0]!.id } : p))).ok).toBe(false); // 중복
    expect(verifySolution(puzzle, withFirst({ x: solution[0]!.x + 100 })).ok).toBe(false); // 판 밖
    expect(verifySolution(puzzle, withFirst({ x: -1 })).ok).toBe(false);
    expect(verifySolution(puzzle, withFirst({ rot: 4 })).ok).toBe(false);
    expect(verifySolution(puzzle, withFirst({ rot: 1.5 })).ok).toBe(false);
    expect(verifySolution(puzzle, withFirst({ x: NaN })).ok).toBe(false);
    expect(verifySolution(puzzle, withFirst({ id: 9999 })).ok).toBe(false);
  });

  it("조각 두 개의 위치를 서로 바꿔 겹치게 하면 거절", () => {
    const [a, b] = solution;
    const swapped = solution.map((p) => (p === a ? { ...p, x: b!.x, y: b!.y } : p));
    expect(verifySolution(puzzle, swapped).ok).toBe(false);
  });

  it("정답 배치는 판의 모든 칸을 정확히 한 번씩 덮음", () => {
    const seen = new Set<string>();
    for (const pl of solution) {
      for (const [r, c] of placedCells(puzzle.pieces.find((p) => p.id === pl.id)!, pl)) seen.add(`${r},${c}`);
    }
    expect(seen.size).toBe(puzzle.size * puzzle.size);
  });
});

describe("블록 채우기: 배당과 시간", () => {
  it("배당표 길이가 단계 수와 같고 단계가 오를수록 커짐", () => {
    expect(RULES.PUZZLE_PAYOUT_MULT.length).toBe(MAX_STAGE);
    for (let c = 2; c <= MAX_STAGE; c++) expect(multFor(c)).toBeGreaterThan(multFor(c - 1));
  });

  it("1·2단계에서 정산하면 손해, 3단계부터 이득", () => {
    const bet = 1_000_000;
    expect(payoutFor(bet, 0)).toBe(0);
    expect(payoutFor(bet, 1)).toBeLessThan(bet);
    expect(payoutFor(bet, 2)).toBeLessThan(bet);
    expect(payoutFor(bet, 3)).toBeGreaterThan(bet);
    for (let c = 3; c <= MAX_STAGE; c++) expect(payoutFor(bet, c)).toBeGreaterThan(bet);
  });

  it("배당 계산 예", () => {
    expect(payoutFor(1_000_000, 1)).toBe(400_000);
    expect(payoutFor(1_000_000, 3)).toBe(1_300_000);
    expect(payoutFor(10_001, 1)).toBe(4000); // 소수점은 버림
  });

  it("배팅 상한으로 최종 단계까지 가도 정수이고 단조 증가", () => {
    let prev = 0;
    for (let c = 1; c <= MAX_STAGE; c++) {
      const v = payoutFor(RULES.PUZZLE_MAX_BET, c);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("마감은 제한 시간 + 여유", () => {
    const cfg = RULES.PUZZLE_STAGES[0]!;
    expect(deadlineMs(1000, 1)).toBe(1000 + cfg.seconds * 1000 + RULES.PUZZLE_GRACE_MS);
  });
});
