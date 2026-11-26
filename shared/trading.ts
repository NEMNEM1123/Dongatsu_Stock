// 거래 규칙 (순수 함수). 서버가 이 함수로 계산하고, 클라이언트는 표시·미리보기에만 쓴다.
//
// 포지션 모델 (모든 금액은 정수 원)
//   cost   : 진입 금액 합계 (수량 × 체결가의 합)
//   margin : 내가 낸 돈 (롱: cost / 레버리지, 숏: cost / 레버리지. 2026-11-26 이전에 연 숏은 cost × 1.5)
//   롱 순자산 = margin + (qty×현재가 − cost)      → 부채 = cost − margin
//   숏 순자산 = margin + (cost − qty×현재가)
// 손실은 margin까지만이고, 잔고는 음수가 되지 않는다.

import { RULES } from "./rules";
import { leveragesOf, STOCKS } from "./stocks";

export type Side = "long" | "short";

export interface Position {
  stock: number;
  side: Side;
  qty: number;
  cost: number;
  margin: number;
  leverage: number;
}

export type OrderResult =
  | {
      ok: true;
      cash: number; // 주문 후 현금
      position: Position | null; // 주문 후 포지션 (null = 전부 정리)
      qty: number;
      notional: number; // 체결 금액 = qty × price
      fee: number;
      pnl: number | null; // 청산(매도·환매)일 때 실현손익(수수료 포함), 진입이면 null
      returned: number; // 청산 시 현금으로 돌려받은 금액
    }
  | { ok: false; error: string };

const err = (error: string): OrderResult => ({ ok: false, error });

const isMacho = (stock?: number): boolean => stock !== undefined && STOCKS.find((s) => s.id === stock)?.kind === "macho";
const feeRate = (stock?: number, leverage = 1): number =>
  isMacho(stock) ? (RULES.MACHO_FEE_RATES[leverage] ?? RULES.FEE_RATE) : RULES.FEE_RATE;

/** 수수료. stock을 주면 그 종목의 수수료율로 계산하고, 상남자 종목은 레버리지에 따라 달라진다. */
export const feeOf = (notional: number, stock?: number, leverage = 1): number => Math.round(notional * feeRate(stock, leverage));

export function validQty(qty: unknown): qty is number {
  return typeof qty === "number" && Number.isInteger(qty) && qty >= 1 && qty <= RULES.MAX_ORDER_QTY;
}

// ── 평가 ──

export function positionEquity(p: Position, price: number): number {
  const value = p.qty * price;
  return p.side === "long" ? p.margin + value - p.cost : p.margin + p.cost - value;
}

export function isLiquidatable(p: Position, price: number): boolean {
  if (p.side === "long" && p.leverage <= 1) return false;
  return positionEquity(p, price) < RULES.MAINTENANCE_MARGIN * p.margin;
}

/**
 * 구간 가격(prices[i] = fromTick+i 의 가격)을 훑어, afterTick 이후 처음 청산 조건에 걸린 tick과 가격을 찾는다.
 * 체크포인트 사이에 청산선을 건드렸다가 되돌아온 경우도 잡아낸다.
 */
export function firstLiquidation(
  p: Position,
  prices: readonly number[],
  fromTick: number,
  afterTick: number,
): { tick: number; price: number } | null {
  for (let t = Math.max(fromTick, afterTick + 1); t < fromTick + prices.length; t++) {
    const price = prices[t - fromTick];
    if (isLiquidatable(p, price)) return { tick: t, price };
  }
  return null;
}

/** 표시용 청산가. 롱은 이 가격 이하, 숏은 이 가격 이상이면 청산. 청산 대상이 아니면 null. */
export function liquidationPrice(p: Position): number | null {
  const room = (1 - RULES.MAINTENANCE_MARGIN) * p.margin; // 청산 전까지 잃을 수 있는 금액
  if (p.side === "long") {
    if (p.leverage <= 1) return null;
    return Math.ceil((p.cost - room) / p.qty);
  }
  return Math.floor((p.cost + room) / p.qty);
}

/** 순자산 = 현금 + 포지션 순자산 합 (포지션 순자산은 0 미만으로 내려가지 않음) */
export function netWorth(
  cash: number,
  positions: readonly Position[],
  priceOf: (stock: number) => number,
): number {
  let sum = cash;
  for (const p of positions) sum += Math.max(0, positionEquity(p, priceOf(p.stock)));
  return sum;
}

// ── 최대 수량 ──

/** unitCost: 1주당 (증거금 + 수수료) 근사값. 근사값에서 시작해 정확한 최대 수량까지 보정한다. */
function maxQty(cash: number, unitCost: number, costOf: (qty: number) => number): number {
  if (cash <= 0 || unitCost <= 0) return 0;
  let q = Math.min(RULES.MAX_ORDER_QTY, Math.floor(cash / unitCost));
  while (q > 0 && costOf(q) > cash) q--;
  while (q < RULES.MAX_ORDER_QTY && costOf(q + 1) <= cash) q++;
  return q;
}

export function maxBuyQty(cash: number, price: number, leverage: number, stock?: number): number {
  return maxQty(cash, price / leverage + price * feeRate(stock, leverage), (q) => Math.ceil((q * price) / leverage) + feeOf(q * price, stock, leverage));
}

/** 공매도는 매수와 증거금·수수료가 같다. (상남자 종목은 공매도할 수 없다) */
export const maxShortQty = (cash: number, price: number, leverage: number): number => maxBuyQty(cash, price, leverage);

// ── 주문 ──

function open(
  cash: number,
  pos: Position | undefined,
  stock: number,
  side: Side,
  qty: number,
  price: number,
  leverage: number,
): OrderResult {
  if (!validQty(qty)) return err("수량이 올바르지 않습니다.");
  const notional = qty * price;
  const margin = Math.ceil(notional / leverage);
  const fee = feeOf(notional, stock, leverage);
  if (margin + fee > cash) return err("잔고가 부족합니다.");
  if (pos && pos.leverage !== leverage) return err(`이미 ${pos.leverage}배 포지션이 있습니다. 같은 배율로만 추가할 수 있습니다.`);
  const position: Position = {
    stock,
    side,
    qty: (pos?.qty ?? 0) + qty,
    cost: (pos?.cost ?? 0) + notional,
    margin: (pos?.margin ?? 0) + margin,
    leverage,
  };
  return { ok: true, cash: cash - margin - fee, position, qty, notional, fee, pnl: null, returned: 0 };
}

function close(cash: number, pos: Position | undefined, qty: number, price: number): OrderResult {
  if (!pos) return err("보유한 포지션이 없습니다.");
  if (!validQty(qty)) return err("수량이 올바르지 않습니다.");
  if (qty > pos.qty) return err("보유 수량보다 많습니다.");
  const full = qty === pos.qty;
  const cost = full ? pos.cost : Math.round((pos.cost * qty) / pos.qty);
  const margin = full ? pos.margin : Math.round((pos.margin * qty) / pos.qty);
  const notional = qty * price;
  const fee = feeOf(notional, pos.stock, pos.leverage);
  const equity = pos.side === "long" ? margin + notional - cost : margin + cost - notional;
  const returned = Math.max(0, equity - fee);
  const position: Position | null = full
    ? null
    : { ...pos, qty: pos.qty - qty, cost: pos.cost - cost, margin: pos.margin - margin };
  return { ok: true, cash: cash + returned, position, qty, notional, fee, pnl: returned - margin, returned };
}

export function buy(cash: number, pos: Position | undefined, stock: number, qty: number, price: number, leverage: number): OrderResult {
  if (!leveragesOf(stock).includes(leverage)) return err(`이 종목은 ${leveragesOf(stock).map((l) => `${l}배`).join("·")}만 고를 수 있습니다.`);
  return open(cash, pos, stock, "long", qty, price, leverage);
}

export const sell = (cash: number, pos: Position | undefined, qty: number, price: number): OrderResult =>
  close(cash, pos, qty, price);

export function short(cash: number, pos: Position | undefined, stock: number, qty: number, price: number, leverage: number): OrderResult {
  if (isMacho(stock)) return err("상남자 마켓에서는 공매도할 수 없습니다.");
  if (!leveragesOf(stock).includes(leverage)) return err(`이 종목은 ${leveragesOf(stock).map((l) => `${l}배`).join("·")}만 고를 수 있습니다.`);
  return open(cash, pos, stock, "short", qty, price, leverage);
}

export const cover = (cash: number, pos: Position | undefined, qty: number, price: number): OrderResult =>
  close(cash, pos, qty, price);

/** 강제 청산: 포지션 전량을 주어진 가격으로 정리한다. */
export function liquidate(cash: number, pos: Position, price: number): Extract<OrderResult, { ok: true }> {
  return close(cash, pos, pos.qty, price) as Extract<OrderResult, { ok: true }>;
}
