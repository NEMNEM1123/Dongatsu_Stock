import { describe, expect, it } from "vitest";
import { advance, priceAt, priceRange, rand, tickAt, type Effect } from "../shared/engine";
import { RULES } from "../shared/rules";
import { STOCKS } from "../shared/stocks";

const SEED = 123456789;
const N = 20_000;

describe("engine 결정성", () => {
  it("같은 입력이면 같은 가격", () => {
    for (const s of STOCKS) expect(priceAt(s, SEED, N)).toBe(priceAt(s, SEED, N));
  });

  it("시드가 다르면 다른 가격 경로", () => {
    const s = STOCKS[3];
    expect(priceAt(s, SEED, N)).not.toBe(priceAt(s, SEED + 1, N));
  });

  it("종목마다 다른 난수", () => {
    expect(rand(SEED, 1, 5, 1)).not.toBe(rand(SEED, 2, 5, 1));
  });

  it("체크포인트에서 이어 계산해도 처음부터 계산한 값과 같음", () => {
    for (const s of STOCKS) {
      const cp = advance(s, SEED, { tick: 0, price: s.basePrice }, 7_777);
      expect(priceAt(s, SEED, N, undefined, cp)).toBe(priceAt(s, SEED, N));
    }
  });

  it("priceRange가 priceAt과 일치", () => {
    const s = STOCKS[6];
    const r = priceRange(s, SEED, 500, 600);
    expect(r).toHaveLength(101);
    r.forEach((p, i) => expect(p).toBe(priceAt(s, SEED, 500 + i)));
  });

  it("난수는 [0,1)이고 대체로 고르게 분포", () => {
    let sum = 0;
    for (let t = 0; t < 10_000; t++) {
      const u = rand(SEED, 1, t, 1);
      if (u < 0 || u >= 1) throw new Error(`out of range: ${u}`);
      sum += u;
    }
    expect(sum / 10_000).toBeGreaterThan(0.48);
    expect(sum / 10_000).toBeLessThan(0.52);
  });

  it("tick은 서버 시각 기준으로 계산", () => {
    const epoch = 1_700_000_000_000;
    expect(tickAt(epoch + 2_000 * 10 + 1_999, epoch)).toBe(10);
    expect(tickAt(epoch + 2_000 * 11, epoch)).toBe(11);
  });
});

describe("engine 가격 성질", () => {
  it("항상 정수이고 하한가 이상", () => {
    for (const s of STOCKS) {
      const r = priceRange(s, SEED, 0, 30_000);
      expect(r.every(Number.isInteger)).toBe(true);
      expect(Math.min(...r)).toBeGreaterThanOrEqual(RULES.PRICE_FLOOR);
    }
  });

  it("기준가 근처에서 폭주하지 않음 (하루치, 일반 종목)", () => {
    for (const s of STOCKS.filter((x) => x.kind === "stock")) {
      const r = priceRange(s, SEED, 0, 43_200);
      expect(Math.min(...r)).toBeGreaterThan(s.basePrice * 0.2);
      expect(Math.max(...r)).toBeLessThan(s.basePrice * 5);
    }
  });

  it("고변동형이 안정형보다 크게 움직임", () => {
    const sd = (id: number) => {
      const s = STOCKS.find((x) => x.id === id)!;
      const r = priceRange(s, SEED, 0, 20_000).map((p) => p / s.basePrice);
      const m = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
    };
    expect(sd(8)).toBeGreaterThan(sd(1));
  });
});

describe("이벤트 효과", () => {
  const s = STOCKS[4];
  const fx: Effect[] = [{ startTick: 1_000, endTick: 1_100, driftPpm: 5_000 }];

  it("효과 시작 전 가격은 불변 (과거 불변)", () => {
    expect(priceAt(s, SEED, 999, fx)).toBe(priceAt(s, SEED, 999));
    expect(priceAt(s, SEED, 1_000, fx)).not.toBe(priceAt(s, SEED, 1_000));
  });

  it("양수 효과는 구간 후 가격을 올림", () => {
    expect(priceAt(s, SEED, 1_100, fx)).toBeGreaterThan(priceAt(s, SEED, 1_100));
  });

  it("효과가 있어도 결정적", () => {
    expect(priceAt(s, SEED, 5_000, fx)).toBe(priceAt(s, SEED, 5_000, fx));
  });
});
