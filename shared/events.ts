// 이벤트: 특정 종목에 일정 시간 동안 추세(드리프트)를 더한다. 서버가 무작위로 만들고, 서버에서만 가격에 적용된다.

import { RULES } from "./rules";
import type { Effect } from "./engine";
import type { StockDef } from "./stocks";

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

// ── 자동 이벤트 ──

const HEADLINES = {
  stock: {
    up: ["{n}, 깜짝 호재에 매수세 몰려", "{n}, 호실적 기대감에 상승세", "{n}, 대형 계약 소식에 강세", "{n}, 인기 급상승… 주문 폭주"],
    down: ["{n}, 악재 소식에 매도세 확산", "{n}, 실적 우려에 하락세", "{n}, 오너 리스크 부각되며 약세", "{n}, 차익 실현 물량 쏟아져"],
  },
  coin: {
    up: ["{n}, 고래 매수 포착… 급등", "{n}, 거래소 상장 기대감에 상승", "{n}, 커뮤니티 열기에 강세"],
    down: ["{n}, 대량 매도 포착… 급락", "{n}, 규제 우려에 약세", "{n}, 투심 위축되며 하락"],
  },
} as const;

/**
 * 이번 tick에 이벤트를 만들지와 다음 예정 tick을 정한다. 간격은 MIN~MAX_GAP_SEC에서 고르게 무작위라서 최대 간격을 넘기지 않는다.
 * saved는 저장해 둔 예정 tick(없으면 null). 예정이 없거나, 오래 지났거나, 최대 간격보다 먼 미래면(tick 기준이 바뀐 경우)
 * 만들지 않고 새로 정한다. 접속하자마자 이벤트가 나오는 것을 노릴 수 없게 하기 위해서다.
 */
export function planAutoEvent(saved: number | null, curTick: number, rnd: () => number, tickMs: number = RULES.TICK_MS): { due: boolean; next: number } {
  const ticks = (sec: number): number => Math.round((sec * 1000) / tickMs);
  const min = ticks(RULES.AUTO_EVENT_MIN_GAP_SEC);
  const max = ticks(RULES.AUTO_EVENT_MAX_GAP_SEC);
  const next = curTick + min + Math.floor(rnd() * (max - min + 1));
  if (saved === null || curTick - saved > ticks(RULES.AUTO_EVENT_IDLE_GRACE_SEC) || saved - curTick > max) return { due: false, next };
  return curTick >= saved ? { due: true, next } : { due: false, next: saved };
}

/**
 * 무작위 이벤트 한 건을 만든다. rnd는 [0,1) 난수 함수(서버는 암호학적 난수를 넣는다).
 * 시작 tick은 호출한 쪽이 정한다 (항상 현재보다 미래여야 한다).
 */
export function makeAutoEvent(rnd: () => number, stock: StockDef, startTick: number): EventInput {
  const up = rnd() < 0.5;
  const pct = Math.round((RULES.AUTO_EVENT_MIN_PCT + rnd() * (RULES.AUTO_EVENT_MAX_PCT - RULES.AUTO_EVENT_MIN_PCT)) * 10) / 10;
  const steps = Math.round((RULES.AUTO_EVENT_MAX_SEC - RULES.AUTO_EVENT_MIN_SEC) / 10);
  const sec = RULES.AUTO_EVENT_MIN_SEC + 10 * Math.floor(rnd() * (steps + 1));
  const pool = HEADLINES[stock.kind === "coin" ? "coin" : "stock"][up ? "up" : "down"];
  const headline = pool[Math.floor(rnd() * pool.length)]!.replace("{n}", stock.name);
  return { stock: stock.id, startTick, durationMin: sec / 60, totalPct: up ? pct : -pct, headline };
}
