// 알바 근무 한 번(run)의 진행 규칙. 저장은 서버가 하고, 여기서는 상태가 어떻게 바뀌는지만 계산한다.
// 근무 시작 때의 수입(unit)과 근무 시간(shift)은 run에 고정해 둔다. (근무 중에 업그레이드를 사도 이번 근무는 그대로)

import {
  calcAnswer, calcProblemCount, calcProblems, calcScore, flipCard, fryPay, fryReadyMs, judgeFry, judgeMemory, matchPay,
  memoryInputMs, memoryRoundPay, memoryShowMs, newMatch, shiftMs, unitPay,
  type CalcProblem, type JobId, type Levels, type MatchState,
} from "./parttime";
import { RULES } from "./rules";

export interface PtRun {
  job: JobId;
  seed: number;
  startedAt: number;
  unit: number;
  shift: number; // ms. 0이면 시간 제한 없음(순서 기억)
  earned: number; // 지금까지 확정된 수입 (계산·짝 맞추기는 끝날 때 정해진다)
  step: number; // 순서 기억: 현재 라운드(1부터) / 튀기기: 지금 튀기는 번호(0부터)
  stepAt: number; // 현재 단계가 시작된 서버 시각
  n: number; // 계산: 문제 수
  match?: MatchState;
  lastFlipAt: number;
  stats: Record<string, number>;
}

export type EndReason = "done" | "time" | "fail" | "early" | "invalid";

export interface PtEnd {
  job: JobId;
  pay: number;
  reason: EndReason;
  stats: Record<string, number>;
}

/** 요청 한 건의 결과 중 화면이 보여 줄 부가 정보 */
export type PtInfo =
  | { kind: "fry"; grade: "perfect" | "good" | "miss" | "cheat"; pay: number }
  | { kind: "memory"; round: number; pay: number }
  | { kind: "flip"; flip: "first" | "match" | "miss"; index: number; symbol: number; other?: number; otherSymbol?: number };

export type PtStep =
  | { k: "invalid"; error: string }
  | { k: "go"; run: PtRun; info?: PtInfo }
  | { k: "end"; end: PtEnd; info?: PtInfo };

const grace = RULES.PUZZLE_GRACE_MS;

export function startRun(job: JobId, levels: Levels, seed: number, now: number): PtRun {
  const run: PtRun = {
    job, seed, startedAt: now, unit: unitPay(job, levels), shift: shiftMs(job, levels),
    earned: 0, step: job === "memory" ? 1 : 0, stepAt: now, n: 0, lastFlipAt: 0, stats: {},
  };
  if (job === "calc") run.n = calcProblemCount(levels);
  if (job === "match") run.match = newMatch(seed);
  return run;
}

/** 근무 시간(또는 순서 기억의 라운드 제한)이 지나 더 이상 입력을 받지 않는가 */
export function isExpired(run: PtRun, now: number): boolean {
  if (run.job === "memory") return now > run.stepAt + memoryShowMs(run.step) + memoryInputMs(run.step) + grace;
  return now > run.startedAt + run.shift + grace;
}

/** 표시용 남은 시간(여유 제외) */
export function remainMs(run: PtRun, now: number): number {
  if (run.job === "memory") return Math.max(0, run.stepAt + memoryShowMs(run.step) + memoryInputMs(run.step) - now);
  return Math.max(0, run.startedAt + run.shift - now);
}

/** 지금 끝낼 때 받는 금액으로 결과를 만든다 (시간 초과·중도 포기·실패 공통) */
export function settle(run: PtRun, now: number, reason: EndReason): PtEnd {
  let pay = run.earned;
  const stats = { ...run.stats };
  if (run.job === "calc") pay = 0; // 제출하지 않은 계산 근무는 채점할 답이 없다
  if (run.job === "match" && run.match) {
    const remain = Math.max(0, run.startedAt + run.shift - now);
    pay = matchPay(run.match.found, RULES.PT_MATCH_PAIRS, reason === "done" ? remain : 0, run.shift, run.unit);
    stats.found = run.match.found;
    stats.flips = run.match.flips;
  }
  return { job: run.job, pay, reason, stats };
}

/** 계산: 근무가 끝났을 때 답을 한 번에 낸다 */
export function submitCalc(run: PtRun, answers: readonly (number | null)[], now: number): PtStep {
  if (run.job !== "calc") return { k: "invalid", error: "지금은 계산 알바 중이 아닙니다." };
  if (!Array.isArray(answers)) return { k: "invalid", error: "답이 올바르지 않습니다." };
  const r = calcScore(calcProblems(run.seed, run.n), answers, now - run.startedAt, run.unit, run.shift);
  const stats = { correct: r.correct, wrong: r.wrong };
  return { k: "end", end: { job: "calc", pay: r.pay, reason: r.valid ? "done" : "invalid", stats } };
}

/** 순서 기억: 라운드의 입력을 낸다. 성공하면 다음 라운드, 틀리면 거기까지의 수입으로 끝 */
export function submitMemory(run: PtRun, input: readonly number[], now: number): PtStep {
  if (run.job !== "memory") return { k: "invalid", error: "지금은 순서 기억 알바 중이 아닙니다." };
  if (!Array.isArray(input) || !input.every((v) => Number.isInteger(v))) return { k: "invalid", error: "입력이 올바르지 않습니다." };
  const j = judgeMemory(run.seed, run.step, input, now - run.stepAt);
  if (j === "toofast") return { k: "invalid", error: "너무 빠릅니다." };
  if (j !== "ok") return { k: "end", end: settle({ ...run, stats: { ...run.stats, rounds: run.step - 1 } }, now, "fail") };
  const pay = memoryRoundPay(run.step, run.unit);
  const next: PtRun = { ...run, earned: run.earned + pay, step: run.step + 1, stepAt: now, stats: { ...run.stats, rounds: run.step } };
  const info: PtInfo = { kind: "memory", round: run.step, pay };
  if (run.step >= RULES.PT_MEMORY_MAX_ROUND) return { k: "end", end: settle(next, now, "done"), info };
  return { k: "go", run: next, info };
}

/** 짝 맞추기: 카드 한 장 뒤집기 */
export function flip(run: PtRun, index: number, now: number): PtStep {
  if (run.job !== "match" || !run.match) return { k: "invalid", error: "지금은 짝 맞추기 알바 중이 아닙니다." };
  if (now - run.lastFlipAt < RULES.PT_MATCH_MIN_FLIP_MS) return { k: "invalid", error: "너무 빠릅니다." };
  const { state, result } = flipCard(run.match, index);
  if (result.kind === "invalid") return { k: "invalid", error: "뒤집을 수 없는 카드입니다." };
  const next: PtRun = { ...run, match: state, lastFlipAt: now };
  const info: PtInfo =
    result.kind === "first" ? { kind: "flip", flip: "first", index: result.index, symbol: result.symbol }
    : result.kind === "match" ? { kind: "flip", flip: "match", index: result.index, symbol: result.symbol, other: result.other }
    : { kind: "flip", flip: "miss", index: result.index, symbol: result.symbol, other: result.other, otherSymbol: result.otherSymbol };
  if (state.found >= RULES.PT_MATCH_PAIRS) return { k: "end", end: settle(next, now, "done"), info };
  return { k: "go", run: next, info };
}

/** 튀기기: 튀김을 건진다. 화면이 잰 시간(clientMs)은 서버가 잰 시간과 맞는 범위일 때만 인정 */
export function pull(run: PtRun, clientMs: number, now: number): PtStep {
  if (run.job !== "fry") return { k: "invalid", error: "지금은 튀기기 알바 중이 아닙니다." };
  const grade = judgeFry(fryReadyMs(run.seed, run.step), clientMs, now - run.stepAt);
  const pay = fryPay(grade, run.unit);
  const stats = { ...run.stats, [grade]: (run.stats[grade] ?? 0) + 1 };
  const next: PtRun = { ...run, earned: run.earned + pay, step: run.step + 1, stepAt: now, stats };
  return { k: "go", run: next, info: { kind: "fry", grade, pay } };
}

/** 근무를 일찍 마친다 (계산은 답을 내야 하므로 별도) */
export function finishEarly(run: PtRun, now: number): PtEnd {
  return settle(run, now, "early");
}

// ── 화면에 보내는 모습 (정답·완성 시각 외의 비밀은 담지 않는다) ──

export interface PtViewData {
  job: JobId;
  unit: number;
  shiftMs: number;
  remainMs: number;
  earned: number;
  calc?: { problems: CalcProblem[] };
  memory?: { round: number; seq: number[]; showMs: number; inputMs: number };
  match?: { cards: number[]; found: number; flips: number; pairs: number };
  fry?: { index: number; readyMs: number };
}

export function viewData(run: PtRun, now: number, memorySeq: (seed: number, round: number) => number[]): PtViewData {
  const v: PtViewData = { job: run.job, unit: run.unit, shiftMs: run.shift, remainMs: remainMs(run, now), earned: run.earned };
  if (run.job === "calc") v.calc = { problems: calcProblems(run.seed, run.n) };
  if (run.job === "memory") v.memory = { round: run.step, seq: memorySeq(run.seed, run.step), showMs: memoryShowMs(run.step), inputMs: memoryInputMs(run.step) };
  if (run.job === "match" && run.match) {
    const m = run.match;
    v.match = { cards: m.layout.map((s, i) => (m.matched[i] || m.open === i ? s : -1)), found: m.found, flips: m.flips, pairs: RULES.PT_MATCH_PAIRS };
  }
  if (run.job === "fry") v.fry = { index: run.step, readyMs: fryReadyMs(run.seed, run.step) };
  return v;
}

export { calcAnswer };
