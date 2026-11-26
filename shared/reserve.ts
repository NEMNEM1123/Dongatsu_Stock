// 예약 주문 (순수 함수). 조건이 맞으면 서버가 그 tick의 가격으로 체결한다.
//   cond "le": 가격이 trigger 이하가 되면 / "ge": trigger 이상이 되면
// 예) 지정가 매수 = buy + le, 손절(롱) = sell + le, 익절(롱) = sell + ge, 숏 손절 = cover + ge, 숏 익절 = cover + le

import { RULES } from "./rules";
import { leveragesOf } from "./stocks";
import { validQty } from "./trading";
import type { OrderAction } from "./protocol";

export type ReserveCond = "le" | "ge";
export type ReserveStatus = "pending" | "filled" | "failed" | "canceled";

export interface ReserveInput {
  stock: number;
  action: OrderAction;
  qty: number;
  leverage: number;
  cond: ReserveCond;
  trigger: number;
}

export interface ReserveItem extends ReserveInput {
  id: number;
  status: ReserveStatus;
  note: string; // 실패·취소 사유
  ts: number; // 등록 시각(ms)
  doneTs: number | null;
  fillPrice: number | null;
}

export const isClosing = (a: OrderAction): boolean => a === "sell" || a === "cover";

export const isTriggered = (cond: ReserveCond, trigger: number, price: number): boolean =>
  cond === "le" ? price <= trigger : price >= trigger;

/**
 * 구간 가격(prices[i] = fromTick+i 의 가격)에서 afterTick 이후 처음 조건이 맞은 tick과 가격.
 * 등록 시점 이전의 가격으로는 체결되지 않도록 afterTick(등록 tick)을 넘긴다.
 */
export function firstTrigger(
  cond: ReserveCond,
  trigger: number,
  prices: readonly number[],
  fromTick: number,
  afterTick: number,
): { tick: number; price: number } | null {
  for (let t = Math.max(fromTick, afterTick + 1); t < fromTick + prices.length; t++) {
    if (isTriggered(cond, trigger, prices[t - fromTick])) return { tick: t, price: prices[t - fromTick] };
  }
  return null;
}

/** 클라이언트가 보낸 값을 검사한다. 종목·포지션 존재 여부는 서버가 따로 본다. */
export function parseReserve(raw: Record<string, unknown>): { ok: true; value: ReserveInput } | { ok: false; error: string } {
  const action = raw.action;
  if (action !== "buy" && action !== "sell" && action !== "short" && action !== "cover") return { ok: false, error: "알 수 없는 주문입니다." };
  const stock = Number(raw.stock);
  const qty = Number(raw.qty);
  const trigger = Number(raw.trigger);
  const opening = action === "buy" || action === "short";
  const leverage = opening ? Number(raw.leverage ?? 1) : 1;
  if (!Number.isInteger(stock)) return { ok: false, error: "없는 종목입니다." };
  if (!validQty(qty)) return { ok: false, error: "수량이 올바르지 않습니다." };
  if (raw.cond !== "le" && raw.cond !== "ge") return { ok: false, error: "조건이 올바르지 않습니다." };
  if (!Number.isInteger(trigger) || trigger < RULES.PRICE_FLOOR) return { ok: false, error: `조건 가격은 ${RULES.PRICE_FLOOR}원 이상의 정수여야 합니다.` };
  if (opening && !leveragesOf(stock).includes(leverage)) return { ok: false, error: "지원하지 않는 레버리지입니다." };
  return { ok: true, value: { stock, action, qty, leverage, cond: raw.cond, trigger } };
}

/** 예약의 한 줄 설명. 예: "삼성전자 70,000원 이하 → 매수 10주" */
export function describeCondition(cond: ReserveCond, trigger: number): string {
  return `${trigger.toLocaleString("ko-KR")}원 ${cond === "le" ? "이하" : "이상"}`;
}
