// 서버가 매 tick 보내 주는 가격을 저장한다. 클라이언트는 가격을 계산하지 않는다.
// (SEED는 서버만 알기 때문에 미래 가격을 미리 알 수 없다.)
// 오늘(한국 시간 0시~) 시가·고가·저가·거래량도 받은 가격으로 이어서 추적한다.

import { bucketTime, INTERVALS } from "../../shared/candles";
import type { DayInit } from "../../shared/protocol";
import { STOCKS } from "../../shared/stocks";

export interface DayStat {
  day: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}

export class PriceBook {
  epoch = 0;
  tickMs = 2000;
  viewSeed = 0; // 호가창 잔량 같은 표시용
  tick = 0; // 마지막으로 받은 tick
  ready = false;
  private prices = new Map<number, number>();
  private order: number[] = STOCKS.map((s) => s.id); // px 배열의 각 칸이 어느 종목인지
  private days = new Map<number, DayStat>();

  /** hello(재연결 포함)를 받을 때마다 호출 */
  init(epoch: number, tickMs: number, viewSeed: number, px: { tick: number; p: number[]; ids?: number[] }, days: DayInit[]): void {
    this.epoch = epoch;
    this.tickMs = tickMs;
    this.viewSeed = viewSeed;
    // 서버가 알려 준 종목 순서를 따른다. 이 화면이 아는 종목 목록과 순서가 달라도 가격이 엉뚱한 종목에 붙지 않는다.
    this.order = px.ids && px.ids.length === px.p.length ? px.ids.slice() : STOCKS.map((s) => s.id);
    this.prices.clear();
    this.days.clear();
    for (const d of days) this.days.set(d.stock, { day: d.day, open: d.open, high: d.high, low: d.low, volume: d.volume });
    this.tick = px.tick - 1;
    this.onPx(px.tick, px.p);
    this.ready = true;
  }

  /** 서버가 보낸 한 tick의 가격 (hello에서 받은 종목 순서) */
  onPx(tick: number, p: number[]): void {
    if (tick <= this.tick) return;
    this.tick = tick;
    const day = bucketTime(tick, this.epoch, this.tickMs, INTERVALS["1d"]);
    this.order.forEach((id, i) => {
      const price = p[i];
      if (typeof price !== "number" || !Number.isFinite(price)) return; // 값이 없으면 이전 가격을 유지한다
      this.prices.set(id, price);
      const d = this.days.get(id);
      if (!d || d.day !== day) {
        this.days.set(id, { day, open: price, high: price, low: price, volume: 0 }); // 자정이 지나 새 하루
      } else {
        if (price > d.high) d.high = price;
        if (price < d.low) d.low = price;
      }
    });
  }

  currentTick(): number {
    return this.tick;
  }

  priceNow(stockId: number): number {
    return this.prices.get(stockId) ?? 0;
  }

  dayStat(stockId: number): DayStat | undefined {
    return this.days.get(stockId);
  }

  addVolume(stockId: number, qty: number): void {
    const d = this.days.get(stockId);
    if (d) d.volume += qty;
  }
}

export const book = new PriceBook();
