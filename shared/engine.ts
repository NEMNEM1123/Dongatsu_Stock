// 결정적 시세 엔진. 같은 (seed, 종목, tick, effects)이면 어디서든 같은 가격.
// 사칙연산(IEEE 754 정확 연산)과 Math.round만 사용한다. exp/log/cos 등은 쓰지 않는다.

import { DRIFT, RULES, VOLATILITY } from "./rules";
import type { StockDef } from "./stocks";

/** 구간 [startTick, endTick) 동안 틱당 수익률에 driftPpm(백만분율, 정수)을 더한다. */
export interface Effect {
  startTick: number;
  endTick: number;
  driftPpm: number;
}

export interface PriceState {
  tick: number;
  price: number;
}

/** 서버 시각 → tick */
export function tickAt(serverNow: number, epoch: number, tickMs: number = RULES.TICK_MS): number {
  return Math.floor((serverNow - epoch) / tickMs);
}

/** (seed, stockId, tick, salt) → [0, 1). 호출 순서와 무관한 해시형 난수. */
export function rand(seed: number, stockId: number, tick: number, salt: number): number {
  let h = (seed | 0) ^ Math.imul(stockId | 0, 0x9e3779b1);
  h = Math.imul(h ^ (tick | 0), 0x85ebca6b);
  h ^= Math.floor(tick / 0x100000000) | 0;
  h = Math.imul(h ^ (salt | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 평균 0, 표준편차 1 근사 (균등분포 4개 합: Irwin-Hall). */
function gauss(seed: number, stockId: number, tick: number): number {
  const sum =
    rand(seed, stockId, tick, 1) +
    rand(seed, stockId, tick, 2) +
    rand(seed, stockId, tick, 3) +
    rand(seed, stockId, tick, 4);
  return (sum - 2) * 1.7320508075688772; // 합의 표준편차 sqrt(4/12) → ×sqrt(3)
}

export function effectDriftPpm(effects: readonly Effect[] | undefined, tick: number): number {
  if (!effects) return 0;
  let sum = 0;
  for (const e of effects) if (tick >= e.startTick && tick < e.endTick) sum += e.driftPpm;
  return sum;
}

/** tick-1 가격 -> tick 가격 */
export function step(
  stock: StockDef,
  seed: number,
  tick: number,
  prevPrice: number,
  effects?: readonly Effect[],
): number {
  const vol = VOLATILITY[stock.profile];
  let r = vol * gauss(seed, stock.id, tick) + (DRIFT[stock.profile] ?? 0);
  r += (RULES.PRICE_REVERT * (stock.basePrice - prevPrice)) / stock.basePrice;
  if (rand(seed, stock.id, tick, 5) < RULES.JUMP_PROB) {
    const sign = rand(seed, stock.id, tick, 6) < 0.5 ? -1 : 1;
    r += sign * RULES.JUMP_SIZE * (0.5 + rand(seed, stock.id, tick, 7));
  }
  r += effectDriftPpm(effects, tick) / 1_000_000;
  const next = Math.round(prevPrice * (1 + r));
  return next < RULES.PRICE_FLOOR ? RULES.PRICE_FLOOR : next;
}

/** from 상태에서 toTick까지 진행한 상태. toTick <= from.tick 이면 from 그대로. */
export function advance(
  stock: StockDef,
  seed: number,
  from: PriceState,
  toTick: number,
  effects?: readonly Effect[],
): PriceState {
  let price = from.price;
  for (let t = from.tick + 1; t <= toTick; t++) price = step(stock, seed, t, price, effects);
  return { tick: Math.max(from.tick, toTick), price };
}

function startState(stock: StockDef, atOrBefore: number, checkpoint?: PriceState): PriceState {
  return checkpoint && checkpoint.tick <= atOrBefore
    ? checkpoint
    : { tick: 0, price: stock.basePrice };
}

/** tick 0의 가격은 기준가. 체크포인트가 없으면 0부터 계산한다. */
export function priceAt(
  stock: StockDef,
  seed: number,
  tick: number,
  effects?: readonly Effect[],
  checkpoint?: PriceState,
): number {
  return advance(stock, seed, startState(stock, tick, checkpoint), tick, effects).price;
}

/** [fromTick, toTick] 구간 가격 배열 (차트용). */
export function priceRange(
  stock: StockDef,
  seed: number,
  fromTick: number,
  toTick: number,
  effects?: readonly Effect[],
  checkpoint?: PriceState,
): number[] {
  let state = advance(stock, seed, startState(stock, fromTick, checkpoint), fromTick, effects);
  const out: number[] = [state.price];
  for (let t = fromTick + 1; t <= toTick; t++) {
    state = { tick: t, price: step(stock, seed, t, state.price, effects) };
    out.push(state.price);
  }
  return out;
}
