import { describe, expect, it } from "vitest";
import { applyPrice, bucketTime, INTERVALS, KST_MS, type Candle } from "../shared/candles";
import { priceRange } from "../shared/engine";
import { STOCKS } from "../shared/stocks";

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0); // 한국 시간 09:00
const TICK_MS = 2000;
const SEED = 424242;

function build(prices: number[], fromTick: number, iv: number): Candle[] {
  const out: Candle[] = [];
  prices.forEach((p, i) => applyPrice(out, bucketTime(fromTick + i, EPOCH, TICK_MS, iv), p));
  return out;
}

describe("candles", () => {
  it("1분봉은 30틱, 시각은 KST 이동값", () => {
    const t0 = bucketTime(0, EPOCH, TICK_MS, INTERVALS["1m"]);
    expect(t0 * 1000).toBe(EPOCH + KST_MS);
    expect(bucketTime(29, EPOCH, TICK_MS, INTERVALS["1m"])).toBe(t0);
    expect(bucketTime(30, EPOCH, TICK_MS, INTERVALS["1m"])).toBe(t0 + 60);
  });

  it("1일봉은 한국 시간 자정에 끊김", () => {
    // EPOCH = KST 09:00 → 15시간 뒤(= 27000틱)가 다음 날 00:00
    const a = bucketTime(26_999, EPOCH, TICK_MS, INTERVALS["1d"]);
    const b = bucketTime(27_000, EPOCH, TICK_MS, INTERVALS["1d"]);
    expect(b - a).toBe(86_400);
  });

  it("OHLC 집계가 맞음", () => {
    const c = build([100, 120, 90, 110], 0, INTERVALS["5m"]);
    expect(c).toEqual([{ t: c[0].t, o: 100, h: 120, l: 90, c: 110, v: 0 }]);
  });

  it("체크포인트로 나눠 집계한 뒤 합쳐도 한 번에 집계한 것과 같음", () => {
    const s = STOCKS[4];
    const prices = priceRange(s, SEED, 0, 3_000);
    for (const iv of Object.values(INTERVALS)) {
      const whole = build(prices, 0, iv);
      // 700 틱 지점(봉 중간)에서 나눠 서버처럼 upsert 병합
      const a = build(prices.slice(0, 701), 0, iv);
      const b = build(prices.slice(701), 701, iv);
      const merged = [...a];
      for (const c of b) {
        const last = merged[merged.length - 1];
        if (last.t === c.t) {
          last.h = Math.max(last.h, c.h);
          last.l = Math.min(last.l, c.l);
          last.c = c.c;
        } else merged.push(c);
      }
      expect(merged).toEqual(whole);
    }
  });
});
