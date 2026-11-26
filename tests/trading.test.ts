import { describe, expect, it } from "vitest";
import {
  buy, cover, feeOf, firstLiquidation, isLiquidatable, liquidate, liquidationPrice, maxBuyQty, maxShortQty,
  netWorth, positionEquity, sell, short, type OrderResult, type Position,
} from "../shared/trading";
import { RULES } from "../shared/rules";

type Ok = Extract<OrderResult, { ok: true }>;
const ok = (r: OrderResult): Ok => {
  if (!r.ok) throw new Error(r.error);
  return r;
};
const S = 1;

describe("매수·매도 (1배)", () => {
  it("매수하면 현금이 금액+수수료만큼 줄고 포지션이 생김", () => {
    const r = ok(buy(1_000_000, undefined, S, 10, 1_000, 1));
    expect(r.fee).toBe(10); // 10,000 × 0.1%
    expect(r.cash).toBe(1_000_000 - 10_000 - 10);
    expect(r.position).toMatchObject({ qty: 10, cost: 10_000, margin: 10_000, leverage: 1 });
  });

  it("같은 가격에 사고 팔면 수수료 2번만큼만 손해", () => {
    const b = ok(buy(1_000_000, undefined, S, 10, 1_000, 1));
    const s = ok(sell(b.cash, b.position!, 10, 1_000));
    expect(s.position).toBeNull();
    expect(s.cash).toBe(1_000_000 - 10 - 10);
    expect(s.pnl).toBe(-10);
  });

  it("잔고 부족·보유 초과·잘못된 수량은 거부", () => {
    expect(buy(10_000, undefined, S, 10, 1_000, 1).ok).toBe(false); // 수수료까지 모자람
    expect(buy(1_000_000, undefined, S, 0, 1_000, 1).ok).toBe(false);
    expect(buy(1_000_000, undefined, S, 1.5, 1_000, 1).ok).toBe(false);
    expect(buy(1_000_000, undefined, S, 1, 1_000, 4).ok).toBe(false); // 없는 배율
    const b = ok(buy(1_000_000, undefined, S, 10, 1_000, 1));
    expect(sell(b.cash, b.position!, 11, 1_000).ok).toBe(false);
    expect(sell(b.cash, undefined, 1, 1_000).ok).toBe(false);
  });

  it("추가 매수하면 평균가가 합쳐지고, 일부 매도하면 비례해 줄어듦", () => {
    const a = ok(buy(5_000_000, undefined, S, 10, 1_000, 1));
    const b = ok(buy(a.cash, a.position!, S, 10, 2_000, 1));
    expect(b.position).toMatchObject({ qty: 20, cost: 30_000 }); // 평균 1,500
    const c = ok(sell(b.cash, b.position!, 5, 3_000));
    expect(c.position).toMatchObject({ qty: 15, cost: 22_500 });
    expect(c.pnl).toBe(5 * 3_000 - 7_500 - feeOf(15_000));
  });
});

describe("레버리지", () => {
  it("2배: 내 돈은 절반, 수익은 2배", () => {
    const b = ok(buy(1_000_000, undefined, S, 100, 1_000, 2)); // 금액 10만
    expect(b.position!.margin).toBe(50_000);
    expect(b.cash).toBe(1_000_000 - 50_000 - feeOf(100_000));
    const s = ok(sell(b.cash, b.position!, 100, 1_100)); // +10%
    expect(s.pnl).toBe(10_000 - feeOf(110_000)); // 부채를 갚고 남은 10,000이 수익
  });

  it("다른 배율로는 추가 매수 불가", () => {
    const a = ok(buy(5_000_000, undefined, S, 10, 1_000, 2));
    expect(buy(a.cash, a.position!, S, 10, 1_000, 3).ok).toBe(false);
    expect(buy(a.cash, a.position!, S, 10, 1_000, 2).ok).toBe(true);
  });

  it("청산 경계: 2배는 62.5 미만, 5배는 85 미만에서 청산 (진입 100)", () => {
    const p2 = ok(buy(1e9, undefined, S, 10, 100, 2)).position!;
    expect(isLiquidatable(p2, 63)).toBe(false);
    expect(isLiquidatable(p2, 62)).toBe(true);
    const p5 = ok(buy(1e9, undefined, S, 10, 100, 5)).position!;
    expect(isLiquidatable(p5, 85)).toBe(false);
    expect(isLiquidatable(p5, 84)).toBe(true);
    expect(liquidationPrice(p5)).toBe(85);
  });

  it("1배 롱은 청산되지 않음", () => {
    const p = ok(buy(1e9, undefined, S, 10, 100, 1)).position!;
    expect(isLiquidatable(p, 1)).toBe(false);
    expect(liquidationPrice(p)).toBeNull();
  });

  it("강제 청산하면 남은 증거금만 돌려받고, 잔고는 음수가 되지 않음", () => {
    const p = ok(buy(1e9, undefined, S, 100, 1_000, 5)).position!; // margin 20,000
    const mild = liquidate(0, p, 840); // 증거금 20,000 − 16,000 = 4,000 남음
    expect(mild.returned).toBe(4_000 - feeOf(84_000));
    const crash = liquidate(0, p, 700); // 손실이 증거금 초과
    expect(crash.cash).toBe(0);
    expect(crash.pnl).toBe(-20_000);
  });
});

describe("공매도", () => {
  it("1배는 거래 금액만큼 증거금을 잠그고, 하락하면 이익", () => {
    const o = ok(short(1_000_000, undefined, S, 10, 1_000, 1));
    expect(o.position).toMatchObject({ side: "short", qty: 10, cost: 10_000, margin: 10_000, leverage: 1 });
    expect(o.cash).toBe(1_000_000 - 10_000 - feeOf(10_000));
    const c = ok(cover(o.cash, o.position!, 10, 800)); // 20% 하락 → 이익 2,000
    expect(c.pnl).toBe(2_000 - feeOf(8_000));
    expect(c.position).toBeNull();
  });

  it("5배: 증거금은 5분의 1, 5% 하락하면 증거금 대비 +25%", () => {
    const o = ok(short(1_000_000, undefined, S, 100, 1_000, 5)); // 금액 10만
    expect(o.position!.margin).toBe(20_000);
    const c = ok(cover(o.cash, o.position!, 100, 950));
    expect(c.pnl).toBe(5_000 - feeOf(95_000));
  });

  it("청산 경계: 1배는 175 초과, 2배는 137.5 초과, 5배는 115 초과 (진입 100)", () => {
    for (const [lev, safe, liq] of [[1, 175, 176], [2, 137, 138], [3, 125, 126], [5, 115, 116]] as const) {
      const p = ok(short(1e9, undefined, S, 300, 100, lev)).position!;
      expect(isLiquidatable(p, safe)).toBe(false);
      expect(isLiquidatable(p, liq)).toBe(true);
      expect(liquidationPrice(p)).toBe(safe);
    }
  });

  it("변경 전에 연 공매도(증거금 150%)는 증거금이 그대로라 212.5 초과에서 청산", () => {
    const old: Position = { stock: S, side: "short", qty: 10, cost: 1_000, margin: 1_500, leverage: 1 };
    expect(isLiquidatable(old, 212)).toBe(false);
    expect(isLiquidatable(old, 213)).toBe(true);
    expect(ok(cover(0, old, 10, 100)).returned).toBe(1_500 - feeOf(1_000));
  });

  it("다른 배율 추가와 없는 배율은 거부", () => {
    const a = ok(short(5_000_000, undefined, S, 10, 1_000, 2));
    expect(short(a.cash, a.position!, S, 10, 1_000, 3).ok).toBe(false);
    expect(short(a.cash, a.position!, S, 10, 1_000, 2).ok).toBe(true);
    expect(short(5_000_000, undefined, S, 10, 1_000, 4).ok).toBe(false);
    expect(short(5_000_000, undefined, S, 10, 1_000, 10).ok).toBe(false);
  });

  it("급등으로 증거금을 넘겨 잃어도 잔고는 음수가 안 됨", () => {
    const p = ok(short(1e9, undefined, S, 10, 100, 1)).position!; // margin 1,000
    const r = liquidate(0, p, 400); // 손실 3,000
    expect(r.cash).toBe(0);
  });

  it("잔고 부족 시 거부", () => {
    expect(short(10_000, undefined, S, 10, 1_000, 1).ok).toBe(false); // 증거금 10,000 + 수수료
  });
});

describe("최대 수량", () => {
  it("최대 수량은 사지고, +1은 못 삼", () => {
    for (const cash of [1_000, 99_999, 1_234_567, 10_000_000]) {
      for (const price of [100, 777, 15_800, 123_000]) {
        for (const lev of RULES.LEVERAGES) {
          const q = maxBuyQty(cash, price, lev);
          if (q > 0) expect(buy(cash, undefined, S, q, price, lev).ok).toBe(true);
          expect(buy(cash, undefined, S, q + 1, price, lev).ok).toBe(false);
        }
        for (const lev of RULES.LEVERAGES) {
          const sq = maxShortQty(cash, price, lev);
          if (sq > 0) expect(short(cash, undefined, S, sq, price, lev).ok).toBe(true);
          expect(short(cash, undefined, S, sq + 1, price, lev).ok).toBe(false);
        }
      }
    }
  });
});

describe("자산 보존", () => {
  it("같은 가격에서 무작위로 사고팔아도 순자산은 수수료만큼만 줄어듦", () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const price = 1_337;
    let cash = 10_000_000;
    const start = cash;
    let pos: Position | undefined;
    let fees = 0;
    for (let i = 0; i < 500; i++) {
      const lev = RULES.LEVERAGES[Math.floor(rnd() * 4)];
      const qty = 1 + Math.floor(rnd() * 300);
      const kind = rnd();
      let r: OrderResult;
      if (kind < 0.5) r = buy(cash, pos?.side === "long" ? pos : undefined, S, qty, price, pos?.side === "long" ? pos.leverage : lev);
      else r = sell(cash, pos?.side === "long" ? pos : undefined, Math.min(qty, pos?.qty ?? 0) || 1, price);
      if (!r.ok) continue;
      cash = r.cash;
      pos = r.position ?? undefined;
      fees += r.fee;
      expect(cash).toBeGreaterThanOrEqual(0);
      expect(netWorth(cash, pos ? [pos] : [], () => price)).toBe(start - fees);
    }
  });

  it("순자산: 롱·숏 평가가 합산되고 음수 포지션은 0으로 계산", () => {
    const l = ok(buy(1e9, undefined, 1, 10, 100, 5)).position!;
    const s = ok(short(1e9, undefined, 2, 10, 100, 1)).position!;
    const price = (id: number) => (id === 1 ? 50 : 100); // 롱 큰 손실(증거금 200 → 평가 음수)
    expect(positionEquity(l, 50)).toBeLessThan(0);
    expect(netWorth(1_000, [l, s], price)).toBe(1_000 + 0 + s.margin);
  });
});

describe("체크포인트 구간 청산 검사", () => {
  const pos = ok(buy(1e9, undefined, S, 10, 100, 5)).position!; // 85 미만에서 청산

  it("구간 중간에 청산선을 건드렸다가 회복해도 그 tick을 찾아냄", () => {
    const prices = [99, 95, 90, 84, 92, 101]; // tick 11~16, 14번째(=84)에서 청산
    expect(firstLiquidation(pos, prices, 11, 10)).toEqual({ tick: 14, price: 84 });
  });

  it("포지션을 연 tick 이전의 가격은 무시", () => {
    const prices = [80, 80, 99, 99]; // tick 11~14: 열리기 전(tick 12까지)의 80은 무시
    expect(firstLiquidation(pos, prices, 11, 12)).toBeNull();
  });

  it("걸리지 않으면 null", () => {
    expect(firstLiquidation(pos, [99, 98, 97], 1, 0)).toBeNull();
  });
});
