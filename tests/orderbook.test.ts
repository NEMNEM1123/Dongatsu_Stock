import { describe, expect, it } from "vitest";
import { BOOK_LEVELS, buildBook, tickSize } from "../shared/orderbook";
import { STOCKS } from "../shared/stocks";

describe("가상 호가창", () => {
  const s = STOCKS[3];

  it("같은 (seed, 종목, tick, 가격)이면 항상 같음", () => {
    expect(buildBook(s, 99, 1234, 24_010)).toEqual(buildBook(s, 99, 1234, 24_010));
  });

  it("tick이 바뀌면 잔량이 바뀜", () => {
    expect(buildBook(s, 99, 1234, 24_010)).not.toEqual(buildBook(s, 99, 1235, 24_010));
  });

  it("매도는 현재가보다 위, 매수는 아래이며 호가 단위 간격", () => {
    for (const price of [150, 1_999, 2_000, 24_010, 49_999, 123_456, 800_000]) {
      const b = buildBook(s, 1, 10, price);
      const ts = tickSize(price);
      expect(b.asks).toHaveLength(BOOK_LEVELS);
      expect(b.asks[0].price).toBeGreaterThan(price);
      expect(b.asks[0].price - price).toBeLessThanOrEqual(ts);
      expect(b.asks[1].price - b.asks[0].price).toBe(ts);
      expect(b.bids[0].price).toBeLessThan(price + (price % ts === 0 ? 0 : 1));
      expect(price - b.bids[0].price).toBeLessThanOrEqual(ts);
      expect(b.bids[0].price - b.bids[1].price).toBe(ts);
      expect(b.asks.every((l) => Number.isInteger(l.price) && l.qty >= 1)).toBe(true);
    }
  });
});
