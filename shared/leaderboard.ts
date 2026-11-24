// 리더보드 계산 (순수 함수). 값은 전부 서버가 계산한다.

import { KST_MS } from "./candles";
import { RULES } from "./rules";

export type Period = "live" | "week" | "season" | "all";
export type Metric = "nw" | "rate" | "honor";
export const PERIODS: Period[] = ["live", "week", "season", "all"];
export const METRICS: Metric[] = ["nw", "rate", "honor"];

export interface UserSnap {
  id: number;
  nw: number; // 현재 순자산
  stars: number;
}
export interface Baseline {
  nw: number;
  stars: number;
}
export type Values = Record<Metric, number>;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** 별을 반영한 시작 자금 */
export const startCapital = (stars: number): number =>
  Math.round(RULES.START_CASH * (1 + RULES.PRESTIGE_BONUS_PER_STAR * stars));

/** 명예 점수 = 별 × 10억 + 순자산 (별 하나가 순자산 10억과 같은 값) */
export const honorScore = (stars: number, nw: number): number => stars * RULES.PRESTIGE_NET_WORTH + nw;

/** 실시간: 순자산 / 시작 자금 대비 수익률 / 명예 점수 */
export function liveValues(s: UserSnap): Values {
  return { nw: s.nw, rate: round6(s.nw / startCapital(s.stars) - 1), honor: honorScore(s.stars, s.nw) };
}

/** 주간·시즌: 기준 시점 대비 증가분 */
export function gainValues(s: UserSnap, b: Baseline): Values {
  const delta = s.nw - b.nw;
  return {
    nw: delta,
    rate: b.nw > 0 ? round6(delta / b.nw) : 0,
    honor: (s.stars - b.stars) * RULES.PRESTIGE_NET_WORTH + delta,
  };
}

/** 역대 기록: 지표별 최고값을 유지한다. 바뀌었으면 changed=true */
export function peakUpdate(prev: Values | undefined, v: Values): { peak: Values; changed: boolean } {
  if (!prev) return { peak: { ...v }, changed: true };
  const peak: Values = { nw: Math.max(prev.nw, v.nw), rate: Math.max(prev.rate, v.rate), honor: Math.max(prev.honor, v.honor) };
  return { peak, changed: peak.nw !== prev.nw || peak.rate !== prev.rate || peak.honor !== prev.honor };
}

export interface Ranked {
  id: number;
  v: number;
  rank: number;
}

/** 값 내림차순, 같으면 먼저 가입한 계정(id가 작은 쪽) 우선. 순위는 1부터 연속. */
export function rankBy(entries: readonly { id: number; v: number }[]): Ranked[] {
  return [...entries]
    .sort((a, b) => b.v - a.v || a.id - b.id)
    .map((e, i) => ({ id: e.id, v: e.v, rank: i + 1 }));
}

/** 한국 시간 월요일 0시에 시작하는 주의 식별자 (그 월요일의 일 번호) */
export function weekIdOf(ms: number): number {
  const day = Math.floor((ms + KST_MS) / 86_400_000);
  const weekday = (day + 3) % 7; // 1970-01-01은 목요일 → 월요일=0
  return day - weekday;
}

/** weekId → 표시용 라벨 (예: 2026-11-23 주) */
export function weekLabel(weekId: number): string {
  return `${new Date(weekId * 86_400_000).toISOString().slice(0, 10)} 주`;
}
