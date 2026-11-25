// 블록 채우기 퍼즐: 서버가 정답이 있는 판을 만들고, 제출된 배치가 판을 빈틈없이 채우는지 검사한다.
// 판 생성은 서버 전용(정답 분할을 알면 안 됨). 조각 모양 계산(rotate 등)은 화면에서도 쓴다.
// 조각은 판을 먼저 여러 덩어리로 잘라서 만들기 때문에 항상 풀 수 있다.

import { mulberry32, shuffle } from "./prng";
import { RULES } from "./rules";

export type Cell = readonly [row: number, col: number];

/** 화면에 보여 줄 조각. cells는 (0,0) 기준으로 정규화된 모양 */
export interface PieceDef {
  id: number;
  cells: Cell[];
}

export interface Puzzle {
  stage: number; // 1부터
  size: number;
  seconds: number;
  pieces: PieceDef[];
}

/** rot: 시계 방향 90도 횟수(0~3). x, y: 회전한 조각의 왼쪽 위 모서리가 놓일 칸(열, 행) */
export interface Placement {
  id: number;
  rot: number;
  x: number;
  y: number;
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

export const MAX_STAGE: number = RULES.PUZZLE_STAGES.length;

export function stageConfig(stage: number): (typeof RULES.PUZZLE_STAGES)[number] {
  const s = RULES.PUZZLE_STAGES[stage - 1];
  if (!s) throw new Error(`invalid stage: ${stage}`);
  return s;
}

// ---------- 배당·시간 ----------

/** 단계를 `cleared`개 깼을 때의 배당 배수. 0단계면 0(아직 아무것도 못 깸). */
export function multFor(cleared: number): number {
  if (cleared <= 0) return 0;
  return RULES.PUZZLE_PAYOUT_MULT[Math.min(cleared, MAX_STAGE) - 1] ?? 0;
}

/** 단계를 `cleared`개 깼을 때 받는 금액(원). */
export function payoutFor(bet: number, cleared: number): number {
  return Math.floor(bet * multFor(cleared));
}

/** 서버가 정답을 받아 주는 마감 시각 */
export function deadlineMs(startedAt: number, stage: number): number {
  return startedAt + stageConfig(stage).seconds * 1000 + RULES.PUZZLE_GRACE_MS;
}

// ---------- 모양 ----------

/** 모양을 왼쪽 위 (0,0) 기준으로 옮기고 정렬한다 */
export function normalize(cells: readonly Cell[]): Cell[] {
  const r0 = Math.min(...cells.map((c) => c[0]));
  const c0 = Math.min(...cells.map((c) => c[1]));
  return cells.map((c): Cell => [c[0] - r0, c[1] - c0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** 시계 방향으로 `rot`번 90도 회전 (정규화됨) */
export function rotate(cells: readonly Cell[], rot: number): Cell[] {
  let cur: readonly Cell[] = cells;
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) {
    cur = cur.map((c): Cell => [c[1], -c[0]]);
    cur = normalize(cur);
  }
  return normalize(cur);
}

/** 배치된 조각이 차지하는 판 위의 칸들 (판 밖 여부는 검사하지 않음) */
export function placedCells(piece: PieceDef, p: Placement): Cell[] {
  return rotate(piece.cells, p.rot).map((c): Cell => [c[0] + p.y, c[1] + p.x]);
}

// ---------- 검증 ----------

export function verifySolution(puzzle: Puzzle, placements: readonly Placement[]): VerifyResult {
  const n = puzzle.size;
  if (!Array.isArray(placements) || placements.length !== puzzle.pieces.length) {
    return { ok: false, error: "모든 조각을 놓아야 합니다." };
  }
  const byId = new Map(puzzle.pieces.map((p) => [p.id, p]));
  const used = new Set<number>();
  const filled = new Uint8Array(n * n);
  for (const pl of placements) {
    const piece = byId.get(pl?.id);
    if (!piece) return { ok: false, error: "알 수 없는 조각입니다." };
    if (used.has(pl.id)) return { ok: false, error: "같은 조각을 두 번 놓을 수 없습니다." };
    used.add(pl.id);
    if (![pl.rot, pl.x, pl.y].every(Number.isInteger) || pl.rot < 0 || pl.rot > 3) {
      return { ok: false, error: "잘못된 배치입니다." };
    }
    for (const [r, c] of placedCells(piece, pl)) {
      if (r < 0 || c < 0 || r >= n || c >= n) return { ok: false, error: "판 밖에 놓은 조각이 있습니다." };
      const i = r * n + c;
      if (filled[i]) return { ok: false, error: "조각이 겹쳤습니다." };
      filled[i] = 1;
    }
  }
  if (filled.some((v) => v === 0)) return { ok: false, error: "빈칸이 남았습니다." };
  return { ok: true };
}

// ---------- 생성 (서버 전용) ----------

/** size×size 판을 연결된 덩어리들로 자른다. 반환값은 덩어리별 칸 번호(행*size+열) */
function partition(size: number, minPiece: number, maxPiece: number, rnd: () => number): number[][] {
  const n = size * size;
  const owner = new Array<number>(n).fill(-1);
  const groups: number[][] = [];

  const nbrs = (i: number): number[] => {
    const r = Math.floor(i / size);
    const c = i % size;
    const out: number[] = [];
    if (r > 0) out.push(i - size);
    if (r < size - 1) out.push(i + size);
    if (c > 0) out.push(i - 1);
    if (c < size - 1) out.push(i + 1);
    return out;
  };

  for (const start of shuffle([...Array(n).keys()], rnd)) {
    if (owner[start] !== -1) continue;
    const gi = groups.length;
    const g = [start];
    owner[start] = gi;
    const target = minPiece + Math.floor(rnd() * (maxPiece - minPiece + 1));
    while (g.length < target) {
      const frontier: number[] = [];
      for (const c of g) for (const nb of nbrs(c)) if (owner[nb] === -1) frontier.push(nb);
      if (frontier.length === 0) break;
      const pick = frontier[Math.floor(rnd() * frontier.length)]!;
      owner[pick] = gi;
      g.push(pick);
    }
    groups.push(g);
  }

  // 너무 작은 덩어리는 이웃 중 가장 작은 덩어리에 합친다
  for (;;) {
    const idx = groups.findIndex((g) => g.length > 0 && g.length < minPiece);
    if (idx < 0) break;
    const g = groups[idx]!;
    let best = -1;
    for (const c of g) {
      for (const nb of nbrs(c)) {
        const o = owner[nb]!;
        if (o !== idx && (best < 0 || groups[o]!.length < groups[best]!.length)) best = o;
      }
    }
    if (best < 0) break; // 판 전체가 한 덩어리뿐인 경우
    for (const c of g) {
      owner[c] = best;
      groups[best]!.push(c);
    }
    groups[idx] = [];
  }
  return groups.filter((g) => g.length > 0);
}

export interface Generated {
  puzzle: Puzzle;
  /** 한 가지 정답 (테스트·디버깅용. 클라이언트에 보내지 않는다) */
  solution: Placement[];
}

export function generatePuzzle(seed: number, stage: number): Generated {
  const cfg = stageConfig(stage);
  const rnd = mulberry32(seed);
  const groups = partition(cfg.size, cfg.minPiece, cfg.maxPiece, rnd);

  const pieces: PieceDef[] = [];
  const solution: Placement[] = [];
  shuffle(groups, rnd).forEach((g, id) => {
    const abs: Cell[] = g.map((i): Cell => [Math.floor(i / cfg.size), i % cfg.size]);
    const norm = normalize(abs);
    // 화면에는 무작위로 돌려 놓은 모양을 주고, 정답은 그걸 되돌리는 회전으로 기록한다
    const shown = Math.floor(rnd() * 4);
    pieces.push({ id, cells: rotate(norm, shown) });
    solution.push({
      id,
      rot: (4 - shown) % 4,
      x: Math.min(...abs.map((c) => c[1])),
      y: Math.min(...abs.map((c) => c[0])),
    });
  });
  return { puzzle: { stage, size: cfg.size, seconds: cfg.seconds, pieces }, solution };
}
