// 관리자 이벤트: 특정 종목에 일정 시간 동안 추세(드리프트)를 더한다. 서버에서만 적용된다.

import { RULES } from "./rules";
import type { Effect } from "./engine";

export interface EventInput {
  stock: number;
  startTick: number;
  durationMin: number;
  totalPct: number; // 기간 전체에서 더해지는 변동률(%) — 양수는 호재, 음수는 악재
  headline: string;
}

export const ticksPerMinute = (tickMs: number = RULES.TICK_MS): number => 60_000 / tickMs;

/** 기간 전체 변동률을 틱당 드리프트(ppm, 정수)로 바꾼다. 복리로 합쳐져 totalPct에 가깝게 된다. */
export function driftPpmFor(totalPct: number, durationMin: number, tickMs: number = RULES.TICK_MS): number {
  const ticks = Math.round(durationMin * ticksPerMinute(tickMs));
  const perTick = Math.pow(1 + totalPct / 100, 1 / ticks) - 1;
  return Math.round(perTick * 1_000_000);
}

export function toEffect(e: EventInput, tickMs: number = RULES.TICK_MS): Effect {
  return {
    startTick: e.startTick,
    endTick: e.startTick + Math.round(e.durationMin * ticksPerMinute(tickMs)),
    driftPpm: driftPpmFor(e.totalPct, e.durationMin, tickMs),
  };
}

/** 노이즈 없이 효과만 적용했을 때의 기대 경로(미리보기용): 매 분 시점의 배수(1.0 = 시작 가격) */
export function previewMultipliers(totalPct: number, durationMin: number, tickMs: number = RULES.TICK_MS): number[] {
  const ppm = driftPpmFor(totalPct, durationMin, tickMs) / 1_000_000;
  const out: number[] = [];
  for (let m = 0; m <= durationMin; m++) out.push(Math.pow(1 + ppm, m * ticksPerMinute(tickMs)));
  return out;
}

/** 등록 검사. currentTick은 서버의 현재 tick. 오류 문구를 돌려주고, 문제 없으면 null. */
export function validateEvent(e: EventInput, currentTick: number, stockExists: boolean): string | null {
  if (!stockExists) return "없는 종목입니다.";
  if (!Number.isFinite(e.totalPct) || Math.abs(e.totalPct) > RULES.EVENT_MAX_ABS_PCT || e.totalPct === 0) {
    return `변동률은 0이 아니고 ±${RULES.EVENT_MAX_ABS_PCT}% 이내여야 합니다.`;
  }
  if (!Number.isFinite(e.durationMin) || e.durationMin < 1 || e.durationMin > RULES.EVENT_MAX_DURATION_MIN) {
    return `지속 시간은 1~${RULES.EVENT_MAX_DURATION_MIN}분이어야 합니다.`;
  }
  const head = e.headline.trim();
  if (head.length < 2 || head.length > 80) return "뉴스 문구는 2~80자여야 합니다.";
  // 과거 가격은 절대 바뀌면 안 된다: 시작 tick은 반드시 미래여야 한다
  if (!Number.isInteger(e.startTick) || e.startTick < currentTick + RULES.EVENT_MIN_LEAD_TICKS) {
    return "적용 시점은 지금보다 미래여야 합니다.";
  }
  if (e.startTick > currentTick + RULES.EVENT_MAX_AHEAD_MIN * ticksPerMinute()) {
    return `적용 시점은 최대 ${Math.round(RULES.EVENT_MAX_AHEAD_MIN / 60 / 24)}일 이내여야 합니다.`;
  }
  return null;
}
