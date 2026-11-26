// 거래 기록으로부터 내 성적표 · 일일 미션 · 업적 진행도를 계산한다 (순수 함수).
// 진행도는 항상 거래 기록에서 다시 계산하므로 별도 카운터를 저장하지 않는다.

import { RULES } from "./rules";
import { STOCKS } from "./stocks";

export interface TradeRow {
  stock: number; // 0 = 복권·프레스티지
  action: string;
  qty: number;
  price: number;
  fee: number;
  pnl: number | null;
  leverage: number;
  ts: number;
}

export interface LotterySummary {
  tickets: number;
  cost: number;
  payout: number;
  maxPayout: number; // 한 번 구매로 받은 최대 당첨금
}

const TRADE_ACTIONS = new Set(["buy", "sell", "short", "cover"]);
const CLOSE_ACTIONS = new Set(["sell", "cover"]);

// ── 성적표 ──

export interface StockStat {
  stock: number;
  pnl: number;
  closed: number;
  wins: number;
}

export interface MyStats {
  trades: number; // 매수·매도·공매도·환매 체결 수
  closed: number; // 손익이 확정된 거래(정리 + 강제청산) 수
  wins: number;
  losses: number;
  realized: number; // 확정 손익 합계
  fees: number;
  liquidations: number;
  best: { stock: number; pnl: number } | null;
  worst: { stock: number; pnl: number } | null;
  byStock: StockStat[]; // 손익 큰 순
  lottery: LotterySummary;
}

export function summarize(rows: readonly TradeRow[], lottery: LotterySummary): MyStats {
  let trades = 0, closed = 0, wins = 0, losses = 0, realized = 0, fees = 0, liquidations = 0;
  let best: MyStats["best"] = null;
  let worst: MyStats["worst"] = null;
  const per = new Map<number, StockStat>();
  for (const r of rows) {
    if (r.stock === 0) continue; // 복권·프레스티지는 거래가 아님
    if (TRADE_ACTIONS.has(r.action)) trades++;
    fees += r.fee;
    const settled = (CLOSE_ACTIONS.has(r.action) || r.action === "liquidation") && r.pnl !== null;
    if (r.action === "liquidation") liquidations++;
    if (!settled) continue;
    const pnl = r.pnl as number;
    closed++;
    realized += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
    if (!best || pnl > best.pnl) best = { stock: r.stock, pnl };
    if (!worst || pnl < worst.pnl) worst = { stock: r.stock, pnl };
    const s = per.get(r.stock) ?? { stock: r.stock, pnl: 0, closed: 0, wins: 0 };
    s.pnl += pnl;
    s.closed++;
    if (pnl > 0) s.wins++;
    per.set(r.stock, s);
  }
  const byStock = [...per.values()].sort((a, b) => b.pnl - a.pnl || a.stock - b.stock);
  return { trades, closed, wins, losses, realized, fees, liquidations, best, worst, byStock, lottery };
}

// ── 미션 · 업적 ──

export type MetricKind =
  | "trades" | "stocks" | "profits" | "volume" | "lottery" | "lotteryMax"
  | "liquidations" | "prestiges" | "realized" | "lev5profit";

/**
 * 기록에서 지표 하나를 센다. minNotional: 이 금액 미만의 일반 거래는 세지 않는다 (미션은 소액 반복을 막기 위해 사용).
 */
export function metric(kind: MetricKind, rows: readonly TradeRow[], lottery: LotterySummary, minNotional = 0): number {
  const counts = (r: TradeRow) => TRADE_ACTIONS.has(r.action) && r.stock !== 0 && r.qty * r.price >= minNotional;
  switch (kind) {
    case "trades":
      return rows.filter(counts).length;
    case "stocks":
      return new Set(rows.filter(counts).map((r) => r.stock)).size;
    case "profits":
      return rows.filter((r) => counts(r) && CLOSE_ACTIONS.has(r.action) && (r.pnl ?? 0) > 0).length;
    case "lev5profit":
      return rows.filter((r) => counts(r) && CLOSE_ACTIONS.has(r.action) && (r.pnl ?? 0) > 0 && r.leverage >= 5).length;
    case "volume":
      return rows.filter(counts).reduce((s, r) => s + r.qty * r.price, 0);
    case "lottery":
      return lottery.tickets;
    case "lotteryMax":
      return lottery.maxPayout;
    case "liquidations":
      return rows.filter((r) => r.action === "liquidation").length;
    case "prestiges":
      return rows.filter((r) => r.action === "prestige").length;
    case "realized":
      return rows.reduce((s, r) => s + ((CLOSE_ACTIONS.has(r.action) || r.action === "liquidation") && r.stock !== 0 ? r.pnl ?? 0 : 0), 0);
  }
}

export interface MissionDef { id: string; kind: MetricKind; target: number; reward: number; title: string }
export type AchievementKind =
  | "trades" | "volume" | "stocks" | "profits" | "grossProfit" | "realized" | "bestProfit"
  | "fees" | "losses" | "worstLoss" | "liquidations"
  | "shorts" | "shortProfits" | "shortLev5Profit" | "lev5profit"
  | "machoTrades" | "machoProfits" | "lev50profit" | "coinTrades" | "coinProfits" | "etfTrades"
  | "lottery" | "lotteryMax" | "puzzlePlays" | "puzzleCleared" | "puzzleMaxPayout"
  | "jobShifts" | "jobPay" | "jobKinds" | "upgradeLevels" | "missions" | "prestiges";

export interface AchievementDef { id: string; cat: string; kind: AchievementKind; target: number; title: string; desc: string }

/** 거래·복권 기록 밖에서 서버가 따로 모아 주는 값 */
export interface ActivitySummary {
  puzzlePlays: number;
  puzzleCleared: number; // 한 판에서 깬 최대 단계
  puzzleMaxPayout: number;
  jobShifts: number; // 수입이 있었던 근무 수
  jobPay: number;
  jobKinds: number;
  upgradeLevels: number;
  missions: number; // 미션 보상을 받은 횟수
}

export const NO_ACTIVITY: ActivitySummary = {
  puzzlePlays: 0, puzzleCleared: 0, puzzleMaxPayout: 0, jobShifts: 0, jobPay: 0, jobKinds: 0, upgradeLevels: 0, missions: 0,
};

export interface MissionView extends MissionDef { progress: number; claimed: boolean }
export interface AchievementView extends AchievementDef { progress: number; done: boolean }

/** 그날의 미션. 날짜(KST 일 번호)로 정해지므로 모든 유저가 같은 미션을 받고, 같은 종류는 겹치지 않는다. */
export function dailyMissions(day: number): MissionDef[] {
  const pool: MissionDef[] = RULES.MISSION_POOL.map((m) => ({ ...m }));
  // 날짜를 시드로 하는 간단한 섞기 (재현 가능해야 하므로 Math.random 사용 금지)
  let s = (day * 2654435761) >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: MissionDef[] = [];
  const kinds = new Set<string>();
  for (const m of pool) {
    if (kinds.has(m.kind)) continue;
    kinds.add(m.kind);
    out.push(m);
    if (out.length >= RULES.MISSIONS_PER_DAY) break;
  }
  return out;
}

export const claimKey = (day: number, missionId: string): string => `d:${day}:${missionId}`;

export function missionViews(day: number, todayRows: readonly TradeRow[], todayLottery: LotterySummary, claimed: ReadonlySet<string>): MissionView[] {
  return dailyMissions(day).map((m) => ({
    ...m,
    progress: Math.min(m.target, metric(m.kind, todayRows, todayLottery, RULES.MISSION_MIN_NOTIONAL)),
    claimed: claimed.has(claimKey(day, m.id)),
  }));
}

/** 업적에 쓰는 값을 거래 기록을 한 번만 훑어서 모두 계산한다. */
export function achievementValues(rows: readonly TradeRow[], lottery: LotterySummary, activity: ActivitySummary): Record<AchievementKind, number> {
  const v: Record<AchievementKind, number> = {
    ...activity,
    trades: 0, volume: 0, stocks: 0, profits: 0, grossProfit: 0, realized: 0, bestProfit: 0,
    fees: 0, losses: 0, worstLoss: 0, liquidations: 0,
    shorts: 0, shortProfits: 0, shortLev5Profit: 0, lev5profit: 0,
    machoTrades: 0, machoProfits: 0, lev50profit: 0, coinTrades: 0, coinProfits: 0, etfTrades: 0,
    lottery: lottery.tickets, lotteryMax: lottery.maxPayout, prestiges: 0,
  };
  const kindOf = new Map(STOCKS.map((s) => [s.id, s.kind]));
  const traded = new Set<number>();
  for (const r of rows) {
    if (r.action === "prestige") v.prestiges++;
    if (r.stock === 0) continue; // 복권·퍼즐·프레스티지는 거래가 아님
    const kind = kindOf.get(r.stock);
    const isTrade = TRADE_ACTIONS.has(r.action);
    const isClose = CLOSE_ACTIONS.has(r.action);
    v.fees += r.fee;
    if (isTrade) {
      v.trades++;
      v.volume += r.qty * r.price;
      traded.add(r.stock);
      if (kind === "macho") v.machoTrades++;
      else if (kind === "coin") v.coinTrades++;
      else if (kind === "etf") v.etfTrades++;
    }
    if (r.action === "short") v.shorts++;
    if (r.action === "liquidation") v.liquidations++;
    if ((!isClose && r.action !== "liquidation") || r.pnl === null) continue;
    v.realized += r.pnl;
    if (r.pnl < 0) {
      v.losses++;
      v.worstLoss = Math.max(v.worstLoss, -r.pnl);
    }
    if (!isClose || r.pnl <= 0) continue; // 아래는 직접 정리해서 낸 수익만
    v.profits++;
    v.grossProfit += r.pnl;
    v.bestProfit = Math.max(v.bestProfit, r.pnl);
    if (r.leverage >= 5) v.lev5profit++;
    if (r.leverage >= 50) v.lev50profit++;
    if (r.action === "cover") {
      v.shortProfits++;
      if (r.leverage >= 5) v.shortLev5Profit++;
    }
    if (kind === "macho") v.machoProfits++;
    else if (kind === "coin") v.coinProfits++;
  }
  v.stocks = traded.size;
  return v;
}

export function achievementViews(rows: readonly TradeRow[], lottery: LotterySummary, activity: ActivitySummary = NO_ACTIVITY): AchievementView[] {
  const values = achievementValues(rows, lottery, activity);
  return RULES.ACHIEVEMENTS.map((a) => {
    const value = values[a.kind];
    return { ...a, progress: Math.max(0, Math.min(a.target, value)), done: value >= a.target };
  });
}
