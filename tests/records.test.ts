import { describe, expect, it } from "vitest";
import { RULES } from "../shared/rules";
import {
  achievementValues, achievementViews, NO_ACTIVITY, claimKey, dailyMissions, metric, missionViews, summarize,
  type LotterySummary, type TradeRow,
} from "../shared/records";

const noLottery: LotterySummary = { tickets: 0, cost: 0, payout: 0, maxPayout: 0 };
let ts = 0;
const row = (o: Partial<TradeRow>): TradeRow => ({ stock: 1, action: "buy", qty: 100, price: 10_000, fee: 1_000, pnl: null, leverage: 1, ts: ++ts, ...o });

describe("성적표", () => {
  it("승패·실현손익·수수료를 집계", () => {
    const rows = [
      row({ action: "buy" }),
      row({ action: "sell", pnl: 50_000 }),
      row({ action: "buy", stock: 2 }),
      row({ action: "sell", stock: 2, pnl: -20_000 }),
      row({ action: "liquidation", stock: 2, pnl: -100_000 }),
    ];
    const s = summarize(rows, noLottery);
    expect(s.trades).toBe(4);
    expect(s.closed).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.realized).toBe(-70_000);
    expect(s.liquidations).toBe(1);
    expect(s.fees).toBe(5_000);
    expect(s.best).toEqual({ stock: 1, pnl: 50_000 });
    expect(s.worst).toEqual({ stock: 2, pnl: -100_000 });
    expect(s.byStock.map((x) => x.stock)).toEqual([1, 2]);
    expect(s.byStock[1]).toMatchObject({ pnl: -120_000, closed: 2, wins: 0 });
  });

  it("복권·프레스티지(stock 0)는 거래로 세지 않는다", () => {
    const s = summarize([row({ stock: 0, action: "lottery", pnl: 990_000 }), row({ stock: 0, action: "prestige", pnl: 5 })], noLottery);
    expect(s.trades).toBe(0);
    expect(s.closed).toBe(0);
    expect(s.realized).toBe(0);
  });

  it("기록이 없어도 안전", () => {
    const s = summarize([], noLottery);
    expect(s.best).toBeNull();
    expect(s.byStock).toEqual([]);
  });
});

describe("지표", () => {
  it("소액 거래는 미션 기준에서 제외", () => {
    const small = row({ qty: 1, price: 100 });
    const big = row({ qty: 100, price: 10_000 });
    expect(metric("trades", [small, big], noLottery, RULES.MISSION_MIN_NOTIONAL)).toBe(1);
    expect(metric("trades", [small, big], noLottery, 0)).toBe(2);
  });

  it("서로 다른 종목 수와 수익 정리 수", () => {
    const rows = [
      row({ stock: 1 }), row({ stock: 2 }), row({ stock: 2 }),
      row({ stock: 1, action: "sell", pnl: 10 }), row({ stock: 2, action: "cover", pnl: -5 }),
    ];
    expect(metric("stocks", rows, noLottery)).toBe(2);
    expect(metric("profits", rows, noLottery)).toBe(1);
  });

  it("5배 수익 정리", () => {
    expect(metric("lev5profit", [row({ action: "sell", pnl: 100, leverage: 5 })], noLottery)).toBe(1);
    expect(metric("lev5profit", [row({ action: "sell", pnl: 100, leverage: 3 })], noLottery)).toBe(0);
    expect(metric("lev5profit", [row({ action: "sell", pnl: -100, leverage: 5 })], noLottery)).toBe(0);
  });

  it("복권 지표는 복권 요약에서 가져온다", () => {
    const lot = { tickets: 7, cost: 70_000, payout: 0, maxPayout: 1_000_000 };
    expect(metric("lottery", [], lot)).toBe(7);
    expect(metric("lotteryMax", [], lot)).toBe(1_000_000);
  });
});

describe("일일 미션", () => {
  it("같은 날은 항상 같은 미션이고, 종류가 겹치지 않는다", () => {
    for (let day = 20000; day < 20200; day++) {
      const a = dailyMissions(day);
      expect(a.map((m) => m.id)).toEqual(dailyMissions(day).map((m) => m.id));
      expect(a).toHaveLength(RULES.MISSIONS_PER_DAY);
      expect(new Set(a.map((m) => m.kind)).size).toBe(a.length);
    }
  });

  it("날짜가 바뀌면 구성이 바뀐다", () => {
    const sets = new Set<string>();
    for (let day = 20000; day < 20030; day++) sets.add(dailyMissions(day).map((m) => m.id).join());
    expect(sets.size).toBeGreaterThan(1);
  });

  it("진행도는 목표를 넘지 않고, 수령 여부가 반영된다", () => {
    const day = 20500;
    const m = dailyMissions(day)[0];
    const claimed = new Set([claimKey(day, m.id)]);
    const views = missionViews(day, [], noLottery, claimed);
    expect(views[0].claimed).toBe(true);
    expect(views[0].progress).toBe(0);
    const many = Array.from({ length: 50 }, () => row({ action: "sell", pnl: 1000 }));
    for (const v of missionViews(day, many, { ...noLottery, tickets: 99 }, new Set())) expect(v.progress).toBeLessThanOrEqual(v.target);
  });
});

describe("업적", () => {
  it("조건을 채우면 완료", () => {
    const a = achievementViews([row({ action: "buy" })], noLottery);
    expect(a.find((x) => x.id === "first_trade")?.done).toBe(true);
    expect(a.find((x) => x.id === "liq1")?.done).toBe(false);
    const b = achievementViews([row({ action: "liquidation", pnl: -1 })], noLottery);
    expect(b.find((x) => x.id === "liq1")?.done).toBe(true);
  });

  it("업적은 100개이고 제목이 겹치지 않으며, 분류가 모두 정의돼 있다", () => {
    expect(RULES.ACHIEVEMENTS.length).toBe(100);
    expect(new Set(RULES.ACHIEVEMENTS.map((a) => a.title)).size).toBe(100);
    const cats = new Set<string>(RULES.ACHIEVEMENT_CATEGORIES.map((c) => c.id));
    for (const a of RULES.ACHIEVEMENTS) {
      expect(cats.has(a.cat)).toBe(true);
      expect(a.target).toBeGreaterThan(0);
    }
    for (const c of cats) expect(RULES.ACHIEVEMENTS.some((a) => a.cat === c)).toBe(true);
  });

  it("같은 지표의 목표는 겹치지 않고 점점 커진다", () => {
    const last = new Map<string, number>();
    for (const a of RULES.ACHIEVEMENTS) {
      expect(a.target).toBeGreaterThan(last.get(a.kind) ?? 0);
      last.set(a.kind, a.target);
    }
  });

  it("기록이 없으면 하나도 달성되지 않고, 충분하면 모두 달성할 수 있다", () => {
    expect(achievementViews([], noLottery).filter((a) => a.done)).toEqual([]);
    for (const kind of new Set(RULES.ACHIEVEMENTS.map((a) => a.kind))) expect(achievementValues([], noLottery, NO_ACTIVITY)[kind]).toBe(0);
  });

  it("지표 계산: 수익·손실·공매도·상남자를 구분한다", () => {
    const v = achievementValues(
      [
        row({ stock: 1, action: "short", qty: 10, price: 100, fee: 1, leverage: 5 }),
        row({ stock: 1, action: "cover", qty: 10, price: 90, fee: 1, pnl: 99, leverage: 5 }),
        row({ stock: 301, action: "sell", qty: 1, price: 500, fee: 2, pnl: 300, leverage: 50 }),
        row({ stock: 101, action: "sell", qty: 1, price: 500, fee: 2, pnl: -700, leverage: 1 }),
        row({ stock: 201, action: "liquidation", pnl: -50, leverage: 5 }),
        row({ stock: 0, action: "lottery", pnl: 1_000_000 }),
        row({ stock: 0, action: "prestige" }),
      ],
      { tickets: 3, cost: 30, payout: 20, maxPayout: 20 },
      { ...NO_ACTIVITY, jobShifts: 2, missions: 4 },
    );
    expect(v).toMatchObject({
      trades: 4, stocks: 3, profits: 2, grossProfit: 399, bestProfit: 300, realized: -351, losses: 2, worstLoss: 700, liquidations: 1,
      shorts: 1, shortProfits: 1, shortLev5Profit: 1, lev5profit: 2, lev50profit: 1, machoTrades: 1, machoProfits: 1, coinTrades: 1, coinProfits: 0,
      etfTrades: 0, lottery: 3, lotteryMax: 20, prestiges: 1, jobShifts: 2, missions: 4,
    });
  });

  it("id가 중복되지 않는다", () => {
    const ids = [...RULES.ACHIEVEMENTS.map((a) => a.id), ...RULES.MISSION_POOL.map((m) => m.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
