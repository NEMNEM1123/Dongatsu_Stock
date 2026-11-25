// 알바: 문제 생성, 채점, 수입, 업그레이드 계산. 모두 순수 함수이고, 문제·카드·튀김 시간은 서버가 시드로 만든다.
// 서버는 시각을 직접 재고(클라이언트가 보낸 시간은 믿지 않고 범위만 확인), 채점과 지급도 서버가 한다.

import { mulberry32, shuffle } from "./prng";
import { RULES } from "./rules";

export type JobId = keyof typeof RULES.PT_JOBS;
export const JOB_IDS = Object.keys(RULES.PT_JOBS) as JobId[];

// ── 업그레이드 ──

export type UpgradeId = (typeof RULES.PT_UPGRADES)[number]["id"];
/** 유저의 업그레이드 레벨 (없는 항목은 0) */
export type Levels = Partial<Record<UpgradeId, number>>;

export const upgradeDef = (id: string): (typeof RULES.PT_UPGRADES)[number] | undefined => RULES.PT_UPGRADES.find((u) => u.id === id);

export const levelOf = (levels: Levels, id: UpgradeId): number => Math.max(0, Math.floor(levels[id] ?? 0));

/** 다음 레벨(현재 레벨 → +1)을 사는 비용. 만렙이면 null */
export function upgradeCost(id: UpgradeId, level: number): number | null {
  const def = upgradeDef(id);
  if (!def || level < 0 || level >= def.max) return null;
  return Math.round((def.cost * Math.pow(def.growth, level)) / 100) * 100;
}

/** 업그레이드를 반영한 한 번의 기본 수입(원) */
export function unitPay(job: JobId, levels: Levels): number {
  const wage = 1 + RULES.PT_WAGE_PER_LEVEL * levelOf(levels, "wage");
  const tool = 1 + RULES.PT_JOB_PER_LEVEL * levelOf(levels, job);
  return Math.floor(RULES.PT_JOBS[job].unit * wage * tool);
}

/** 근무 시간(ms). 시간 제한이 없는 알바(순서 기억)는 0 */
export function shiftMs(job: JobId, levels: Levels): number {
  const base = RULES.PT_JOBS[job].shiftSec;
  if (base === 0) return 0;
  return (base + RULES.PT_TIME_PER_LEVEL_SEC * levelOf(levels, "time")) * 1000;
}

// ── 계산 알바 ──

export interface CalcProblem {
  a: number;
  b: number;
  op: "+" | "-" | "×";
}

export function calcAnswer(p: CalcProblem): number {
  return p.op === "+" ? p.a + p.b : p.op === "-" ? p.a - p.b : p.a * p.b;
}

/** 문제 번호가 뒤로 갈수록 어려워진다: 한 자리 덧셈·뺄셈 → 두 자리 → 곱셈. 답은 항상 0 이상. */
export function calcProblems(seed: number, n: number): CalcProblem[] {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const out: CalcProblem[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 6) {
      const a = int(1, 9), b = int(1, 9);
      out.push(rnd() < 0.5 ? { a, b, op: "+" } : { a: Math.max(a, b), b: Math.min(a, b), op: "-" });
    } else if (i < 14) {
      const a = int(10, 99), b = int(10, 99);
      out.push(rnd() < 0.5 ? { a, b, op: "+" } : { a: Math.max(a, b), b: Math.min(a, b), op: "-" });
    } else {
      const r = rnd();
      if (r < 0.4) out.push({ a: int(2, 12), b: int(2, 9), op: "×" });
      else if (r < 0.7) out.push({ a: int(100, 499), b: int(10, 99), op: "+" });
      else out.push({ a: int(200, 999), b: int(10, 199), op: "-" });
    }
  }
  return out;
}

/** 근무 시간 안에 풀 수 있는 최대 문제 수 (문제 하나에 최소 시간이 필요하다) */
export const calcProblemCount = (levels: Levels): number => Math.floor(shiftMs("calc", levels) / RULES.PT_CALC_MIN_ANSWER_MS);

export interface CalcResult {
  correct: number;
  wrong: number;
  pay: number;
  valid: boolean; // false면 사람이 낼 수 없는 속도라서 수입 0
}

/** answers[i]는 i번 문제의 답 (null은 건너뜀). 건너뛴 문제는 정답도 오답도 아니다. */
export function calcScore(problems: readonly CalcProblem[], answers: readonly (number | null)[], elapsedMs: number, unit: number, shift: number): CalcResult {
  const answered = answers.filter((a) => a !== null).length;
  const bad: CalcResult = { correct: 0, wrong: 0, pay: 0, valid: false };
  if (answers.length > problems.length) return bad;
  if (elapsedMs > shift + RULES.PUZZLE_GRACE_MS) return bad;
  if (elapsedMs < answered * RULES.PT_CALC_MIN_ANSWER_MS) return bad;
  let correct = 0, wrong = 0;
  answers.forEach((a, i) => {
    if (a === null) return;
    if (typeof a === "number" && Number.isFinite(a) && a === calcAnswer(problems[i]!)) correct++;
    else wrong++;
  });
  return { correct, wrong, pay: Math.max(0, correct * unit - Math.floor((wrong * unit) / 2)), valid: true };
}

// ── 순서 기억 알바 ──

export const memoryLength = (round: number): number => round + 2;

/** r라운드에 보여 주는 메뉴 순서 (0 ~ MENU-1). 같은 시드·라운드면 항상 같다. */
export function memorySeq(seed: number, round: number): number[] {
  const rnd = mulberry32(seed ^ Math.imul(round, 0x9e3779b1));
  return Array.from({ length: memoryLength(round) }, () => Math.floor(rnd() * RULES.PT_MEMORY_MENU));
}

export const memoryShowMs = (round: number): number => memoryLength(round) * RULES.PT_MEMORY_SHOW_MS;
/** 보여 준 뒤 입력할 수 있는 시간 */
export const memoryInputMs = (round: number): number => memoryLength(round) * 1500 + 3000;

export type MemoryJudge = "ok" | "wrong" | "timeout" | "toofast";

/** elapsedMs: 라운드가 시작(서버가 순서를 보낸 시각)된 뒤 서버가 잰 시간 */
export function judgeMemory(seed: number, round: number, input: readonly number[], elapsedMs: number): MemoryJudge {
  if (elapsedMs > memoryShowMs(round) + memoryInputMs(round) + RULES.PUZZLE_GRACE_MS) return "timeout";
  if (elapsedMs < memoryShowMs(round) + memoryLength(round) * 120) return "toofast"; // 다 보기도 전에, 또는 사람이 누를 수 없는 속도
  const want = memorySeq(seed, round);
  return input.length === want.length && input.every((v, i) => v === want[i]) ? "ok" : "wrong";
}

/** r라운드를 성공했을 때 그 라운드의 수입 */
export const memoryRoundPay = (round: number, unit: number): number => unit * round;

// ── 짝 맞추기 알바 ──

export function matchLayout(seed: number, pairs: number = RULES.PT_MATCH_PAIRS): number[] {
  const cards: number[] = [];
  for (let i = 0; i < pairs; i++) cards.push(i, i);
  return shuffle(cards, mulberry32(seed));
}

export interface MatchState {
  layout: number[];
  open: number | null; // 첫 번째로 뒤집어 둔 카드
  matched: boolean[];
  flips: number;
  found: number;
}

export const newMatch = (seed: number, pairs: number = RULES.PT_MATCH_PAIRS): MatchState => {
  const layout = matchLayout(seed, pairs);
  return { layout, open: null, matched: layout.map(() => false), flips: 0, found: 0 };
};

export type FlipResult =
  | { kind: "invalid" }
  | { kind: "first"; index: number; symbol: number }
  | { kind: "match"; index: number; symbol: number; other: number }
  | { kind: "miss"; index: number; symbol: number; other: number; otherSymbol: number };

/** 카드 i를 뒤집는다. 두 번째 카드에서 짝이 맞으면 match, 아니면 miss(둘 다 다시 덮인다). */
export function flipCard(s: MatchState, i: number): { state: MatchState; result: FlipResult } {
  if (!Number.isInteger(i) || i < 0 || i >= s.layout.length || s.matched[i] || s.open === i) return { state: s, result: { kind: "invalid" } };
  const symbol = s.layout[i]!;
  if (s.open === null) return { state: { ...s, open: i, flips: s.flips + 1 }, result: { kind: "first", index: i, symbol } };
  const other = s.open;
  const otherSymbol = s.layout[other]!;
  if (otherSymbol === symbol) {
    const matched = s.matched.slice();
    matched[i] = matched[other] = true;
    return { state: { ...s, open: null, matched, flips: s.flips + 1, found: s.found + 1 }, result: { kind: "match", index: i, symbol, other } };
  }
  return { state: { ...s, open: null, flips: s.flips + 1 }, result: { kind: "miss", index: i, symbol, other, otherSymbol } };
}

/** 맞춘 짝 수만큼 지급. 전부 맞췄으면 남은 시간 비율만큼 보너스 */
export function matchPay(found: number, pairs: number, remainMs: number, shift: number, unit: number): number {
  const base = found * unit;
  if (found < pairs || shift <= 0) return base;
  const ratio = Math.min(1, Math.max(0, remainMs / shift));
  return base + Math.floor(base * RULES.PT_MATCH_TIME_BONUS * ratio);
}

// ── 돈까스 튀기기 ──

/** n번째 튀김이 완성되는 시각(ms). 서버만 알고 화면에는 진행 게이지로만 보여 준다. */
export function fryReadyMs(seed: number, n: number): number {
  const rnd = mulberry32(seed ^ Math.imul(n + 1, 0x85ebca6b));
  const span = RULES.PT_FRY_READY_MAX_MS - RULES.PT_FRY_READY_MIN_MS;
  return RULES.PT_FRY_READY_MIN_MS + Math.floor(rnd() * (span + 1));
}

export type FryGrade = "perfect" | "good" | "miss" | "cheat";

/**
 * clientMs: 화면이 튀김을 시작한 뒤 건지기까지 잰 시간(지연 보정용) / serverMs: 서버가 잰 같은 시간.
 * 화면이 서버보다 늦게 쟀다고 주장하거나(시간이 거꾸로), 지연 한도보다 훨씬 짧게 쟀다고 하면 무효.
 */
export function judgeFry(readyMs: number, clientMs: number, serverMs: number): FryGrade {
  if (!Number.isFinite(clientMs) || clientMs < 0) return "cheat";
  if (clientMs > serverMs + 50) return "cheat";
  if (serverMs - clientMs > RULES.PT_FRY_MAX_LAG_MS) return "cheat";
  const d = Math.abs(clientMs - readyMs);
  if (d <= RULES.PT_FRY_PERFECT_MS) return "perfect";
  if (d <= RULES.PT_FRY_GOOD_MS) return "good";
  return "miss";
}

export const fryPay = (grade: FryGrade, unit: number): number => (grade === "perfect" ? unit : grade === "good" ? Math.floor(unit / 2) : 0);
