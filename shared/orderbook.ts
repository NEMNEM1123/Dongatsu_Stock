// 표시용 가상 호가창. 실제 주문장은 없으므로 (SEED, 종목, tick)으로 결정적으로 만든다.
// 모든 유저에게 같게 보이고, 체결은 항상 서버 현재가로 이뤄진다.

import { rand } from "./engine";
import type { StockDef } from "./stocks";

export const BOOK_LEVELS = 8;

/** 호가 단위 (가격대별) */
export function tickSize(price: number): number {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

export interface BookLevel {
  price: number;
  qty: number;
}

export interface OrderBook {
  asks: BookLevel[]; // 매도 호가: 현재가에 가까운 순(가격 오름차순)
  bids: BookLevel[]; // 매수 호가: 현재가에 가까운 순(가격 내림차순)
}

function qtyAt(u: number, price: number): number {
  const scale = Math.min(5, Math.max(0.2, 50_000 / price)); // 싼 종목일수록 잔량이 많다
  return Math.max(1, Math.floor((10 + u * u * 1_990) * scale));
}

export function buildBook(stock: StockDef, seed: number, tick: number, price: number): OrderBook {
  const ts = tickSize(price);
  const firstAsk = (Math.floor(price / ts) + 1) * ts;
  const firstBid = (Math.ceil(price / ts) - 1) * ts;
  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  for (let i = 0; i < BOOK_LEVELS; i++) {
    const ap = firstAsk + i * ts;
    asks.push({ price: ap, qty: qtyAt(rand(seed, stock.id, tick, 20 + i), ap) });
    const bp = firstBid - i * ts;
    if (bp >= 1) bids.push({ price: bp, qty: qtyAt(rand(seed, stock.id, tick, 40 + i), bp) });
  }
  return { asks, bids };
}
