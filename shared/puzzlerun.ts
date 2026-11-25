// 블록 채우기 한 판(run)의 진행 규칙. 저장은 서버가 하고, 여기서는 상태가 어떻게 바뀌는지만 계산한다.
//
//   배팅 → [play: 1단계] → 성공 → [choice] ─ 다음 단계 → [play: 2단계] → …
//                  │                    └ 정산 → 끝(받음)
//                  └ 시간 초과 → 끝(배팅액 잃음)           마지막 단계 성공 → 자동 정산

import { deadlineMs, generatePuzzle, MAX_STAGE, payoutFor, stageConfig, verifySolution, type Placement, type Puzzle } from "./puzzle";
import { RULES } from "./rules";

export interface Run {
  bet: number;
  cleared: number; // 지금까지 깬 단계 수
  stage: number; // 지금 도전 중(play) 이거나 방금 깬(choice) 단계
  seed: number; // 현재 단계 퍼즐의 시드 (서버만 안다)
  startedAt: number; // 현재 단계 시작 시각(ms)
  phase: "play" | "choice";
}

export type OutcomeKind = "lost" | "cashed" | "max";

export interface Outcome {
  kind: OutcomeKind;
  bet: number;
  cleared: number;
  payout: number; // 계좌에 돌려주는 금액 (잃었으면 0)
}

export function checkBet(bet: unknown): string | null {
  if (typeof bet !== "number" || !Number.isInteger(bet)) return "배팅 금액이 올바르지 않습니다.";
  if (bet < RULES.PUZZLE_MIN_BET) return `최소 배팅은 ${RULES.PUZZLE_MIN_BET.toLocaleString("ko-KR")}원입니다.`;
  if (bet > RULES.PUZZLE_MAX_BET) return `최대 배팅은 ${RULES.PUZZLE_MAX_BET.toLocaleString("ko-KR")}원입니다.`;
  return null;
}

export function newRun(bet: number, seed: number, now: number): Run {
  return { bet, cleared: 0, stage: 1, seed, startedAt: now, phase: "play" };
}

/** 지금 도전 중인 단계의 퍼즐 (서버가 시드로 다시 만든다) */
export function puzzleOf(run: Run): Puzzle {
  return generatePuzzle(run.seed, run.stage).puzzle;
}

/** 제한 시간(+여유)이 지났는가. 선택 대기 중에는 시간이 없다. */
export function isExpired(run: Run, now: number): boolean {
  return run.phase === "play" && now > deadlineMs(run.startedAt, run.stage);
}

export const lose = (run: Run): Outcome => ({ kind: "lost", bet: run.bet, cleared: run.cleared, payout: 0 });

export type SubmitResult =
  | { k: "expired"; outcome: Outcome }
  | { k: "invalid"; error: string }
  | { k: "cleared"; run: Run } // 다음 단계를 고르는 상태로
  | { k: "max"; outcome: Outcome }; // 마지막 단계까지 깨서 자동 정산

export function submit(run: Run, placements: readonly Placement[], now: number): SubmitResult {
  if (run.phase !== "play") return { k: "invalid", error: "진행 중인 단계가 없습니다." };
  if (isExpired(run, now)) return { k: "expired", outcome: lose(run) };
  const v = verifySolution(puzzleOf(run), placements);
  if (!v.ok) return { k: "invalid", error: v.error };
  const cleared = run.stage;
  if (cleared >= MAX_STAGE) {
    return { k: "max", outcome: { kind: "max", bet: run.bet, cleared, payout: payoutFor(run.bet, cleared) } };
  }
  return { k: "cleared", run: { ...run, cleared, phase: "choice" } };
}

/** 다음 단계 시작 (choice 상태에서만) */
export function nextStage(run: Run, seed: number, now: number): Run | null {
  if (run.phase !== "choice" || run.stage >= MAX_STAGE) return null;
  return { ...run, stage: run.stage + 1, seed, startedAt: now, phase: "play" };
}

/** 지금까지 깬 단계의 배당을 받고 끝낸다 (choice 상태에서만) */
export function cashOut(run: Run): Outcome | null {
  if (run.phase !== "choice" || run.cleared < 1) return null;
  return { kind: "cashed", bet: run.bet, cleared: run.cleared, payout: payoutFor(run.bet, run.cleared) };
}

/** 화면에 보여 줄 제한 시간 (여유 제외) */
export function remainMs(run: Run, now: number): number {
  if (run.phase !== "play") return 0;
  return Math.max(0, run.startedAt + stageConfig(run.stage).seconds * 1000 - now);
}
