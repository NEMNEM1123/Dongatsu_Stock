import { describe, expect, it } from "vitest";
import { priceAt } from "../shared/engine";
import { RULES } from "../shared/rules";
import { etfPrice, getStock, STOCKS } from "../shared/stocks";

const etfs = STOCKS.filter((s) => s.kind === "etf");
const atBase = (id: number): number => getStock(id).basePrice;

describe("ETF 정의", () => {
  it("ETF가 있고 id·코드가 겹치지 않음", () => {
    expect(etfs.length).toBeGreaterThan(0);
    expect(new Set(STOCKS.map((s) => s.id)).size).toBe(STOCKS.length);
    expect(new Set(STOCKS.map((s) => s.code)).size).toBe(STOCKS.length);
  });

  it("구성 종목은 실제 주식·코인이며(ETF 안에 ETF 금지) 중복·빈 구성이 없음", () => {
    for (const e of etfs) {
      const comps = e.components!;
      expect(comps.length).toBeGreaterThanOrEqual(2);
      expect(new Set(comps.map((c) => c.id)).size).toBe(comps.length);
      for (const c of comps) {
        expect(getStock(c.id).kind).not.toBe("etf");
        expect(c.weight).toBeGreaterThan(0);
      }
    }
  });

  it("종합·안정형·고변동·코인 ETF의 구성이 설명과 맞음", () => {
    const by = (code: string) => getStock(STOCKS.find((s) => s.code === code)!.id).components!.map((c) => c.id);
    expect(by("E01").every((id) => getStock(id).kind === "stock")).toBe(true);
    expect(by("E01").length).toBe(STOCKS.filter((s) => s.kind === "stock").length); // 모든 주식
    expect(by("E02").every((id) => getStock(id).profile === "stable")).toBe(true);
    expect(by("E03").every((id) => getStock(id).profile === "volatile")).toBe(true);
    expect(by("E04").every((id) => getStock(id).kind === "coin")).toBe(true);
    expect(by("E04").length).toBe(STOCKS.filter((s) => s.kind === "coin").length);
  });
});

describe("ETF 가격", () => {
  it("구성 종목이 모두 기준가이면 ETF 시작가", () => {
    for (const e of etfs) expect(etfPrice(e, atBase)).toBe(e.basePrice);
  });

  it("구성 종목이 모두 같은 비율로 오르내리면 ETF도 같은 비율", () => {
    const e = etfs[0]!;
    expect(etfPrice(e, (id) => atBase(id) * 1.1)).toBe(Math.round(e.basePrice * 1.1));
    expect(etfPrice(e, (id) => atBase(id) * 0.8)).toBe(Math.round(e.basePrice * 0.8));
  });

  it("한 종목만 움직이면 비중만큼만 반영 (분산 효과)", () => {
    const e = STOCKS.find((s) => s.code === "E02")!; // 4종목 동일 비중
    const moved = e.components![0]!.id;
    const p = etfPrice(e, (id) => (id === moved ? atBase(id) * 2 : atBase(id)));
    expect(p).toBe(Math.round(e.basePrice * (1 + 1 / 4))); // 한 종목이 2배여도 ETF는 +25%
  });

  it("비중이 다르면 비중 큰 종목이 더 크게 반영", () => {
    const def = { ...etfs[0]!, components: [{ id: 1, weight: 3 }, { id: 2, weight: 1 }] };
    const up1 = etfPrice(def, (id) => (id === 1 ? atBase(1) * 2 : atBase(id)));
    const up2 = etfPrice(def, (id) => (id === 2 ? atBase(2) * 2 : atBase(id)));
    expect(up1).toBeGreaterThan(up2);
  });

  it("가격은 항상 정수이고 하한가 아래로 내려가지 않음", () => {
    const e = etfs[0]!;
    expect(Number.isInteger(etfPrice(e, (id) => atBase(id) * 1.2345))).toBe(true);
    expect(etfPrice(e, () => 0)).toBe(RULES.PRICE_FLOOR);
  });

  it("구성 종목이 아닌 것에는 쓸 수 없음", () => {
    expect(() => etfPrice(getStock(1), atBase)).toThrow();
  });

  it("실제 엔진 가격으로 하루 동안 계산해도 정상 범위이고 개별 종목보다 덜 흔들림", () => {
    const SEED = 12345;
    const N = 43_200; // 하루 (2초 틱)
    const volOf = (series: number[]): number => {
      const r = series.slice(1).map((p, i) => Math.log(p / series[i]!));
      const m = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
    };
    const e = etfs[0]!; // 종합 ETF
    const comps = e.components!.map((c) => getStock(c.id));
    const sample = 200;
    const ticks = Array.from({ length: sample }, (_, i) => Math.floor((i * N) / sample));
    const comp = comps.map((s) => ticks.map((t) => priceAt(s, SEED, t)));
    const etf = ticks.map((_, i) => etfPrice(e, (id) => comp[comps.findIndex((s) => s.id === id)]![i]!));
    for (const p of etf) {
      expect(p).toBeGreaterThan(e.basePrice * 0.5);
      expect(p).toBeLessThan(e.basePrice * 2);
    }
    const avgComp = comp.map(volOf).reduce((a, b) => a + b, 0) / comp.length;
    expect(volOf(etf)).toBeLessThan(avgComp); // 분산투자: 구성 종목 평균 변동성보다 작다
  });
});
