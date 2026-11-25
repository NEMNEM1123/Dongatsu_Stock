import { describe, expect, it } from "vitest";
import { advance, type PriceState } from "../shared/engine";
import { RULES } from "../shared/rules";
import { STOCKS } from "../shared/stocks";
import { buy, isLiquidatable, sell, short } from "../shared/trading";

const machos = STOCKS.filter((s) => s.kind === "macho");

/** 매수 후 holdTicks 동안 들고 있다가 파는 거래를 많이 해서 이긴 비율과 평균 손익률(원금 대비)을 잰다 */
function simulate(leverage: number, holdTicks: number, trials: number, seedBase: number) {
  let wins = 0, total = 0, n = 0;
  for (let k = 0; k < trials; k++) {
    const s = machos[k % machos.length]!;
    const seed = seedBase + k;
    const start = 50 + ((k * 7919) % 3000);
    let st: PriceState = advance(s, seed, { tick: 0, price: s.basePrice }, start);
    const open = buy(10_000_000, undefined, s.id, 10, st.price, leverage);
    if (!open.ok) continue;
    let pos = open.position!;
    let pnl: number | null = null;
    for (let t = 1; t <= holdTicks; t++) {
      st = advance(s, seed, st, st.tick + 1);
      if (isLiquidatable(pos, st.price)) { pnl = -pos.margin * 0.75; break; } // 청산: 증거금 대부분을 잃는다
    }
    if (pnl === null) {
      const r = sell(open.cash, pos, pos.qty, st.price);
      pnl = r.ok ? (r.pnl ?? 0) : 0;
    }
    total += pnl / pos.margin; n++;
    if (pnl > 0) wins++;
  }
  return { winRate: wins / n, avg: total / n };
}

describe("상남자 마켓", () => {
  it("종목이 있고 모두 고변동 성격", () => {
    expect(machos.length).toBeGreaterThanOrEqual(6);
    for (const s of machos) expect(s.profile).toBe("macho");
  });

  it("레버리지는 10~50배만, 50배까지 가능", () => {
    const s = machos[0]!;
    expect(RULES.MACHO_LEVERAGES.at(-1)).toBe(50);
    expect(buy(10_000_000, undefined, s.id, 1, s.basePrice, 1).ok).toBe(false);
    expect(buy(10_000_000, undefined, s.id, 1, s.basePrice, 5).ok).toBe(false);
    expect(buy(10_000_000, undefined, s.id, 1, s.basePrice, 50).ok).toBe(true);
    // 일반 종목은 그대로 5배까지
    const normal = STOCKS.find((x) => x.kind === "stock")!;
    expect(buy(10_000_000, undefined, normal.id, 1, normal.basePrice, 50).ok).toBe(false);
  });

  it("공매도는 할 수 없음", () => {
    const s = machos[0]!;
    expect(short(10_000_000, undefined, s.id, 1, s.basePrice).ok).toBe(false);
  });

  it("고변동: 같은 시간 동안 코인보다 더 크게 움직임", () => {
    const range = (s: (typeof STOCKS)[number]) => {
      let st: PriceState = { tick: 0, price: s.basePrice };
      let lo = Infinity, hi = 0;
      for (let t = 1; t <= 1800; t++) { st = advance(s, 5, st, t); lo = Math.min(lo, st.price); hi = Math.max(hi, st.price); }
      return (hi - lo) / s.basePrice;
    };
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const coins = STOCKS.filter((s) => s.kind === "coin");
    expect(avg(machos.map(range))).toBeGreaterThan(avg(coins.map(range)) * 1.5);
  });

  it("이기는 경우보다 지는 경우가 더 많고 평균은 손실 (모든 레버리지·보유 시간)", () => {
    for (const lev of RULES.MACHO_LEVERAGES) {
      for (const hold of [30, 150, 900]) {
        const r = simulate(lev, hold, 1500, 1000 + lev + hold);
        expect(r.winRate, `${lev}x ${hold}t winRate`).toBeLessThan(0.5);
        expect(r.avg, `${lev}x ${hold}t avg`).toBeLessThan(0);
      }
    }
  }, 60_000);
});

describe("상남자 마켓 수수료", () => {
  it("상남자 종목만 수수료가 더 높고, 레버리지가 높을수록 더 비쌈", () => {
    const m0 = machos[0]!;
    const fees = RULES.MACHO_LEVERAGES.map((l) => {
      const r = buy(100_000_000, undefined, m0.id, 10, 10_000, l);
      if (!r.ok) throw new Error("buy failed");
      return r.fee;
    });
    for (let i = 1; i < fees.length; i++) expect(fees[i]!).toBeGreaterThan(fees[i - 1]!);
    expect(fees[0]!).toBeGreaterThan(Math.round(100_000 * RULES.FEE_RATE));
    const m = machos[0]!;
    const normal = STOCKS.find((x) => x.kind === "stock")!;
    const a = buy(10_000_000, undefined, m.id, 10, 10_000, 10);
    const b = buy(10_000_000, undefined, normal.id, 10, 10_000, 5);
    if (!a.ok || !b.ok) throw new Error("buy failed");
    expect(a.fee).toBe(Math.round(100_000 * RULES.MACHO_FEE_RATES[10]!));
    expect(b.fee).toBe(Math.round(100_000 * RULES.FEE_RATE));
  });
});
