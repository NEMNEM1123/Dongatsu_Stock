import { DurableObject } from "cloudflare:workers";
import { RULES } from "../shared/rules";
import type { Checkpoint, ClientMsg, ServerMsg, UserInfo } from "../shared/protocol";
import { applyPrice, bucketTime, INTERVALS, INTERVAL_KEYS, type Candle, type IntervalKey } from "../shared/candles";
import { advance, step, tickAt, type Effect, type PriceState } from "../shared/engine";
import {
  buy, cover, firstLiquidation, isLiquidatable, liquidate, liquidationPrice, netWorth, sell, short,
  type OrderResult, type Position,
} from "../shared/trading";
import { KST_MS } from "../shared/candles";
import { LOTTERY_TOTAL_WEIGHT, prizeForRoll } from "../shared/lottery";
import { payoutFor } from "../shared/puzzle";
import { JOB_IDS, levelOf, memorySeq, upgradeCost, upgradeDef, type Levels } from "../shared/parttime";
import {
  finishEarly as ptFinishEarly, flip as ptFlip, isExpired as isPtExpired, pull as ptPull, settle as ptSettle,
  startRun as startPtRun, submitCalc as ptSubmitCalc, submitMemory as ptSubmitMemory, viewData as ptViewData,
  type PtEnd, type PtInfo, type PtRun, type PtStep,
} from "../shared/ptrun";
import { cashOut, checkBet, isExpired, lose, newRun, nextStage, puzzleOf, remainMs, submit as submitPuzzle, type Outcome, type Run } from "../shared/puzzlerun";
import { achievementViews, claimKey, missionViews, summarize, type LotterySummary, type TradeRow } from "../shared/records";
import { firstTrigger, isClosing, parseReserve, type ReserveCond, type ReserveItem, type ReserveStatus } from "../shared/reserve";
import { adjustCash, parseAnnounce } from "../shared/admin";
import { makeAutoEvent, planAutoEvent, toEffect, validateEvent } from "../shared/events";
import { APP_VERSION, CLIENT_VERSION, MIN_CLIENT_VERSION } from "../shared/version";
import {
  gainValues, liveValues, METRICS, peakUpdate, PERIODS, rankBy, startCapital, weekIdOf, weekLabel,
  type Baseline, type Metric, type UserSnap, type Values,
} from "../shared/leaderboard";
import type { DayInit, Fill, FeedItem, HofGroup, LbEntry, MaintenanceInfo, NewsItem, OrderAction, PositionInfo, PtView, PuzzleView, TradeRecord } from "../shared/protocol";
import { etfPrice, getStock, STOCKS } from "../shared/stocks";
import {
  fromHex,
  hashPassword,
  newSalt,
  newToken,
  randomBelow,
  safeEqual,
  sha256Hex,
  toHex,
  validateNickname,
  validatePassword,
} from "./auth";

export interface Env {
  ASSETS: Fetcher;
  MARKET: DurableObjectNamespace<Market>;
  ADMIN_KEY?: string;
  CHECKPOINT_MS?: string; // 개발·테스트용 덮어쓰기. 없으면 RULES.CHECKPOINT_MS
  LB_MS?: string; // 개발·테스트용 덮어쓰기. 없으면 RULES.LEADERBOARD_MS
}

const COOKIE = "session";
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 5 * 60 * 1000;

const PREV_RANK_MS = 10 * 60 * 1000; // 순위 변동 화살표의 비교 기준 간격

interface LbBlob {
  at: number;
  m: Record<Metric, [number, number][]>; // 지표별 [유저 id, 값] — 순위순
  prev: Record<Metric, Record<string, number>>; // 지표별 이전 순위
  prevAt: number;
}

interface LiquidationEvent {
  userId: number;
  stock: number;
  side: "long" | "short";
  qty: number;
  price: number;
  returned: number;
}

interface ReserveDone {
  userId: number;
  item: ReserveItem;
}

type Attachment = { userId: number; nickname: string; role: "user" | "admin"; v?: number };

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}
function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export class Market extends DurableObject<Env> {
  private sql: SqlStorage;
  // 로그인 실패 횟수 (메모리, 최선 노력용 — 하이버네이션 시 초기화되어도 무방)
  private fails = new Map<string, { n: number; first: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      // 체크포인트가 없는 종목이 있을 때만 만든다: 최초 실행, 그리고 새 종목을 추가한 배포 직후.
      // (priceNow는 종목의 체크포인트가 있다고 가정한다. 깨어날 때마다 돌리면 쓰기가 낭비된다)
      const have = Number(this.sql.exec("SELECT COUNT(DISTINCT stock_id) AS n FROM checkpoints WHERE stock_id IN (" + STOCKS.map((s) => s.id).join(",") + ")").one().n);
      if (have < STOCKS.length) this.runCheckpoint();
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(this.nextAlarmAt());
      if (ctx.getWebSockets().length > 0) this.startTicker(); // 깨어났을 때 접속자가 있으면 가격 전송을 이어 간다
    });
  }

  // ── 체크포인트 · OHLC ──
  private checkpointMs(): number {
    return Number(this.env.CHECKPOINT_MS) || RULES.CHECKPOINT_MS;
  }

  /** alarm은 체크포인트(10분)와 리더보드(1분) 주기 중 짧은 쪽으로 깨우고, 각 작업은 자기 주기에만 돈다. */
  private nextAlarmAt(): number {
    const ms = Math.min(this.checkpointMs(), this.lbMs());
    return (Math.floor(Date.now() / ms) + 1) * ms;
  }

  async alarm(): Promise<void> {
    try {
      this.bumpStat("alarms");
      this.flushStats();
      const bucket = String(Math.floor(Date.now() / this.checkpointMs()));
      if (this.metaOpt("ck_bucket") !== bucket) {
        this.runCheckpoint();
        this.setMeta("ck_bucket", bucket);
      }
      this.runLeaderboard();
      if (this.openSockets().length > 0) this.startTicker();
    } catch (e) {
      console.error("alarm failed", e);
    } finally {
      await this.ctx.storage.setAlarm(this.nextAlarmAt());
    }
  }

  /**
   * 종목별로 직전 체크포인트부터 현재 tick까지 가격을 계산해 체크포인트와 OHLC를 저장한다.
   * 가격은 순수 함수라서 늦게 실행돼도(재시작·지연) 같은 결과가 나온다.
   * 이벤트 효과(9단계)가 생기면 여기서 해당 구간의 effects를 step에 넘긴다.
   */
  private runCheckpoint(): void {
    const seed = Number(this.meta("seed"));
    const epoch = Number(this.meta("epoch"));
    const cur = tickAt(Date.now(), epoch, RULES.TICK_MS);
    const paths = new Map<number, { from: number; prices: number[] }>();
    const events: LiquidationEvent[] = [];
    const reserved: ReserveDone[] = [];

    this.ctx.storage.transactionSync(() => {
      // ETF는 구성 종목의 가격으로 계산하므로 주식·코인을 먼저 처리한다
      const order = [...STOCKS.filter((s) => s.kind !== "etf"), ...STOCKS.filter((s) => s.kind === "etf")];
      const nowPx = new Map<number, number>(); // 이번 체크포인트(현재 tick)의 종목별 가격
      for (const stock of order) {
        const row = this.sql
          .exec("SELECT tick, price FROM checkpoints WHERE stock_id = ?", stock.id)
          .toArray()[0];
        const perIv = new Map<IntervalKey, Candle[]>(INTERVAL_KEYS.map((k) => [k, []]));
        const feed = (tick: number, price: number) => {
          for (const k of INTERVAL_KEYS) {
            applyPrice(perIv.get(k)!, bucketTime(tick, epoch, RULES.TICK_MS, INTERVALS[k]), price);
          }
        };

        let tick: number;
        let price: number;
        if (row) {
          tick = Number(row.tick);
          price = Number(row.price);
        } else {
          // 새로 상장하는 종목: 지금 tick에 시작가로 시작한다 (처음 실행할 때는 cur가 0이다)
          tick = cur;
          price = stock.kind === "etf" ? etfPrice(stock, (id) => nowPx.get(id)!) : stock.basePrice;
          feed(tick, price);
        }
        if (row && cur <= tick) { nowPx.set(stock.id, price); continue; }
        const path = { from: tick + 1, prices: [] as number[] };
        if (stock.kind === "etf") {
          // 구성 종목이 같은 구간을 계산했다면 tick마다 ETF 가격을 이어서 계산한다. 어긋나 있으면 현재 tick 가격만 반영한다.
          const comps = stock.components ?? [];
          const aligned = comps.every((c) => { const p = paths.get(c.id); return !!p && p.from === tick + 1 && p.prices.length === cur - tick; });
          if (aligned) {
            for (let k = 0; k < cur - tick; k++) {
              price = etfPrice(stock, (id) => paths.get(id)!.prices[k]!);
              feed(tick + 1 + k, price);
              path.prices.push(price);
            }
          } else if (cur > tick) {
            price = etfPrice(stock, (id) => nowPx.get(id)!);
            feed(cur, price);
            path.from = cur;
            path.prices.push(price);
          }
        } else {
          const fx = this.effects(stock.id);
          for (let t = tick + 1; t <= cur; t++) {
            price = step(stock, seed, t, price, fx);
            feed(t, price);
            path.prices.push(price);
          }
        }
        paths.set(stock.id, path);
        nowPx.set(stock.id, price);
        tick = Math.max(tick, cur);

        this.sql.exec(
          "INSERT OR REPLACE INTO checkpoints (stock_id, tick, price) VALUES (?, ?, ?)",
          stock.id,
          tick,
          price,
        );
        for (const k of INTERVAL_KEYS) {
          for (const c of perIv.get(k)!) {
            // 이전 체크포인트와 같은 봉에 걸치면 시가는 유지하고 고가·저가·종가를 합친다
            this.sql.exec(
              `INSERT INTO candles (stock_id, iv, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (stock_id, iv, t) DO UPDATE SET
                 h = max(h, excluded.h), l = min(l, excluded.l), c = excluded.c, v = v + excluded.v`,
              stock.id, k, c.t, c.o, c.h, c.l, c.c, c.v,
            );
          }
        }
      }
      // 예약 주문을 먼저 체결한 뒤 청산을 검사한다 (체결로 새로 생긴 포지션도 그 tick 이후로 검사된다)
      this.processReserves(paths, reserved);
      this.scanLiquidations(paths, events);
    });
    this.notifyReserves(reserved);
    this.notifyLiquidations(events);
  }

// ── 이벤트 효과 · 가격 스트림 ──
  private effectsMemo: Map<number, Effect[]> | null = null;
  private ticker: ReturnType<typeof setTimeout> | null = null;
  private lastNewsTick = -1;

  /** 종목에 적용되는 이벤트 효과. 서버에서만 쓰이며, 시작 tick이 미래인 이벤트만 등록되므로 과거 가격은 바뀌지 않는다. */
  private effects(stockId: number): Effect[] {
    if (!this.effectsMemo) {
      const memo = new Map<number, Effect[]>();
      const rows = this.sql
        .exec("SELECT stock_id, start_tick, end_tick, drift_ppm FROM events WHERE end_tick > (SELECT COALESCE(MIN(tick), 0) FROM checkpoints)")
        .toArray();
      for (const r of rows) {
        const list = memo.get(Number(r.stock_id)) ?? [];
        list.push({ startTick: Number(r.start_tick), endTick: Number(r.end_tick), driftPpm: Number(r.drift_ppm) });
        memo.set(Number(r.stock_id), list);
      }
      this.effectsMemo = memo;
    }
    return this.effectsMemo.get(stockId) ?? [];
  }

  /** 체크포인트 다음 tick부터 to까지의 가격 (효과 포함). 차트·오늘 통계의 최근 구간을 서버가 직접 계산한다. */
  private pathSince(stockId: number, cp: { tick: number; price: number }, to: number): number[] {
    this.seedCache ??= Number(this.meta("seed"));
    const stock = getStock(stockId);
    if (stock.kind === "etf") {
      const arrays = new Map<number, number[]>();
      for (const c of stock.components ?? []) {
        const r = this.sql.exec("SELECT tick, price FROM checkpoints WHERE stock_id = ?", c.id).toArray()[0];
        if (!r || Number(r.tick) !== cp.tick) return []; // 구성 종목의 체크포인트가 어긋나 있으면 이어 계산하지 않는다
        arrays.set(c.id, this.pathSince(c.id, { tick: Number(r.tick), price: Number(r.price) }, to));
      }
      const n = Math.max(0, to - cp.tick);
      return Array.from({ length: n }, (_, k) => etfPrice(stock, (id) => arrays.get(id)![k]!));
    }
    const fx = this.effects(stockId);
    const out: number[] = [];
    let price = cp.price;
    for (let t = cp.tick + 1; t <= to; t++) {
      price = step(stock, this.seedCache, t, price, fx);
      out.push(price);
    }
    return out;
  }

  private viewSeed(): number {
    let v = this.metaOpt("view_seed");
    if (v === null) {
      v = String(crypto.getRandomValues(new Uint32Array(1))[0] | 0);
      this.setMeta("view_seed", v);
    }
    return Number(v);
  }

  /** 접속자가 있을 때만 tick 경계마다 현재가를 모두에게 보낸다. (SEED는 서버만 알아서 미래 가격을 계산할 수 없다) */
  private startTicker(): void {
    if (this.ticker !== null) return;
    this.lastNewsTick = this.currentTick();
    this.scheduleTick();
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearTimeout(this.ticker);
    this.ticker = null;
  }

  private maybeStopTicker(): void {
    if (this.openSockets().length === 0) this.stopTicker();
  }

  private scheduleTick(): void {
    this.epochCache ??= Number(this.meta("epoch"));
    const now = Date.now();
    const nextTick = tickAt(now, this.epochCache, RULES.TICK_MS) + 1;
    const at = this.epochCache + nextTick * RULES.TICK_MS;
    this.ticker = setTimeout(() => {
      this.ticker = null;
      try {
        this.onTick();
      } catch (e) {
        console.error("tick failed", e);
      }
      if (this.openSockets().length > 0) this.scheduleTick();
    }, Math.max(1, at - now));
  }

  private currentPx(): { tick: number; p: number[] } {
    return { tick: this.currentTick(), p: STOCKS.map((s) => this.priceNow(s.id)) };
  }

  private onTick(): void {
    const px = this.currentPx();
    this.broadcast({ t: "px", tick: px.tick, p: px.p });
    // 이번 tick에 시작하는 이벤트의 뉴스를 알린다 (가격 효과도 이 tick부터 적용된다)
    const rows = this.sql
      .exec("SELECT id, stock_id, start_tick, headline FROM events WHERE start_tick > ? AND start_tick <= ? ORDER BY start_tick", this.lastNewsTick, px.tick)
      .toArray();
    this.lastNewsTick = px.tick;
    if (rows.length > 0) {
      // 뉴스는 열람권이 있는 접속자에게만 보낸다
      const now = Date.now();
      const msgs = rows.map((r) => JSON.stringify({ t: "news", item: this.newsItem(r) } satisfies ServerMsg));
      const allowed = new Map<number, boolean>();
      for (const w of this.openSockets()) {
        const a = w.deserializeAttachment() as Attachment | null;
        if (!a) continue;
        let ok = allowed.get(a.userId);
        if (ok === undefined) { ok = this.newsUntil(a.userId) > now; allowed.set(a.userId, ok); }
        if (ok) for (const m of msgs) w.send(m);
      }
    }
    this.maybeSpawnEvent(px.tick);

    // 접속 중에는 매 tick 예약 주문을 검사한다 (접속하지 않은 동안은 체크포인트에서 지난 구간을 훑는다)
    if (this.hasPendingReserves()) {
      const paths = new Map<number, { from: number; prices: number[] }>(STOCKS.map((s, i) => [s.id, { from: px.tick, prices: [px.p[i]] }]));
      const reserved: ReserveDone[] = [];
      this.ctx.storage.transactionSync(() => this.processReserves(paths, reserved));
      this.notifyReserves(reserved);
    }
  }

  /**
   * 접속자가 있는 동안(tick이 도는 동안) 가끔 서버가 무작위 이벤트를 만든다.
   * 다음 예정 tick은 저장해 두어서 서버가 재시작되어도 최대 간격이 유지된다. (예정은 서버만 안다)
   * 시작 tick은 항상 현재보다 미래라서 과거 가격은 바뀌지 않고, 뉴스는 시작 tick에 나간다.
   * 같은 종목에 이벤트가 겹치지 않게 하고, 동시에 진행되는 수에 상한을 둔다. ETF는 구성 종목에서 가격이 나오므로 제외한다.
   */
  private maybeSpawnEvent(curTick: number): void {
    const rnd = (): number => randomBelow(1_000_000) / 1_000_000;
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'auto_event_tick'").toArray()[0];
    const saved = row ? Number(row.value) : null;
    const plan = planAutoEvent(saved, curTick, rnd);
    if (!plan.due) {
      if (plan.next !== saved) this.setMeta("auto_event_tick", String(plan.next));
      return;
    }
    const busy = this.sql.exec("SELECT stock_id FROM events WHERE end_tick > ?", curTick).toArray().map((r) => Number(r.stock_id));
    if (busy.length >= RULES.AUTO_EVENT_MAX_ACTIVE) return;
    const pool = STOCKS.filter((s) => s.kind !== "etf" && !busy.includes(s.id));
    if (pool.length === 0) return;
    const stock = pool[Math.floor(rnd() * pool.length)]!;
    const input = makeAutoEvent(rnd, stock, curTick + RULES.EVENT_MIN_LEAD_TICKS);
    const err = validateEvent(input, curTick, true);
    if (err) { console.error("auto event rejected", err); return; }
    const fx = toEffect(input);
    this.sql.exec(
      "INSERT INTO events (stock_id, start_tick, end_tick, drift_ppm, total_pct, headline, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      input.stock, fx.startTick, fx.endTick, fx.driftPpm, input.totalPct, input.headline, Date.now(), 0,
    );
    this.effectsMemo = null;
    this.setMeta("auto_event_tick", String(plan.next));
  }

  private newsItem(r: Record<string, SqlStorageValue>): NewsItem {
    this.epochCache ??= Number(this.meta("epoch"));
    return {
      id: Number(r.id),
      ts: this.epochCache + Number(r.start_tick) * RULES.TICK_MS,
      stock: Number(r.stock_id),
      headline: String(r.headline),
    };
  }

  /** 이미 시작된 이벤트의 뉴스 (최근 순). 아직 시작 전인 이벤트는 공개하지 않는다. */
  private recentNews(): NewsItem[] {
    return this.sql
      .exec("SELECT id, stock_id, start_tick, headline FROM events WHERE start_tick <= ? ORDER BY start_tick DESC LIMIT 10", this.currentTick())
      .toArray()
      .map((r) => this.newsItem(r));
  }

  /** 뉴스 열람권 만료 시각(ms). 없으면 0 */
  private newsUntil(userId: number): number {
    const r = this.sql.exec("SELECT until FROM news_pass WHERE user_id = ?", userId).toArray()[0];
    return r ? Number(r.until) : 0;
  }

  /** 뉴스 열람권 구매: 구매 시점 순자산의 NEWS_PASS_RATE를 현금에서 내고 NEWS_PASS_MIN분 동안 뉴스를 받는다. */
  private handleNewsPass(ws: WebSocket, att: Attachment): void {
    let out: ServerMsg = { t: "newsPass", ok: false, error: "처리하지 못했습니다." };
    let events: LiquidationEvent[] = [];
    if (this.rateLimited(att.userId)) {
      ws.send(JSON.stringify({ t: "newsPass", ok: false, error: "너무 빠릅니다. 잠시 후 다시 시도하세요." } satisfies ServerMsg));
      return;
    }
    this.ctx.storage.transactionSync(() => {
      events = this.liquidateUser(att.userId);
      const now = Date.now();
      if (this.newsUntil(att.userId) > now) { out = { t: "newsPass", ok: false, error: "이미 뉴스를 보는 중입니다." }; return; }
      const cash = this.getCash(att.userId);
      const nw = netWorth(cash, this.getPositions(att.userId), (s) => this.priceNow(s));
      const cost = Math.floor(nw * RULES.NEWS_PASS_RATE);
      if (cost <= 0) { out = { t: "newsPass", ok: false, error: "순자산이 없어 구매할 수 없습니다." }; return; }
      if (cost > cash) { out = { t: "newsPass", ok: false, error: `현금이 부족합니다. (필요 ${cost.toLocaleString("ko-KR")}원)` }; return; }
      const until = now + RULES.NEWS_PASS_MIN * 60_000;
      this.setCash(att.userId, cash - cost);
      this.sql.exec("INSERT OR REPLACE INTO news_pass (user_id, until) VALUES (?, ?)", att.userId, until);
      out = { t: "newsPass", ok: true, until, cost, news: this.recentNews() };
    });
    this.notifyLiquidations(events);
    ws.send(JSON.stringify(out));
    ws.send(JSON.stringify(this.accountMsg(att.userId)));
  }

  private maintenanceInfo(): MaintenanceInfo {
    const raw = this.metaOpt("maintenance");
    if (!raw) return { on: false, message: "" };
    try {
      return JSON.parse(raw) as MaintenanceInfo;
    } catch {
      return { on: false, message: "" };
    }
  }

  private minVersion(): number {
    return Math.max(MIN_CLIENT_VERSION, Number(this.metaOpt("min_version") ?? 0) || 0);
  }

  private latestCheckpoints(): Checkpoint[] {
    return this.sql
      .exec("SELECT stock_id, tick, price FROM checkpoints ORDER BY stock_id")
      .toArray()
      .map((r) => ({ stock: Number(r.stock_id), tick: Number(r.tick), price: Number(r.price) }));
  }

  // ── DB 마이그레이션 (스키마를 바꿀 때는 버전을 올려 단계 추가) ──
  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this.sql.exec("SELECT value FROM meta WHERE key='schema_version'").toArray()[0];
    let v = row ? Number(row.value) : 0;

    if (v < 1) {
      this.sql.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
          pw_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          banned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] | 0;
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('seed', ?), ('epoch', ?)", String(seed), String(Math.floor(Date.now() / 60_000) * 60_000));
      v = 1;
    }

    if (v < 2) {
      this.sql.exec(`
        CREATE TABLE checkpoints (
          stock_id INTEGER PRIMARY KEY,
          tick INTEGER NOT NULL,
          price INTEGER NOT NULL
        );
        CREATE TABLE candles (
          stock_id INTEGER NOT NULL,
          iv TEXT NOT NULL,
          t INTEGER NOT NULL,
          o INTEGER NOT NULL,
          h INTEGER NOT NULL,
          l INTEGER NOT NULL,
          c INTEGER NOT NULL,
          v INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (stock_id, iv, t)
        ) WITHOUT ROWID;
      `);
      v = 2;
    }

    if (v < 3) {
      this.sql.exec(`
        CREATE TABLE accounts (
          user_id INTEGER PRIMARY KEY,
          cash INTEGER NOT NULL,
          bailout_day INTEGER NOT NULL DEFAULT 0,
          bailout_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE positions (
          user_id INTEGER NOT NULL,
          stock_id INTEGER NOT NULL,
          side TEXT NOT NULL,
          qty INTEGER NOT NULL,
          cost INTEGER NOT NULL,
          margin INTEGER NOT NULL,
          leverage INTEGER NOT NULL,
          opened_tick INTEGER NOT NULL,
          PRIMARY KEY (user_id, stock_id, side)
        ) WITHOUT ROWID;
        CREATE TABLE trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          stock_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          qty INTEGER NOT NULL,
          price INTEGER NOT NULL,
          fee INTEGER NOT NULL,
          pnl INTEGER,
          leverage INTEGER NOT NULL
        );
        CREATE INDEX trades_user ON trades (user_id, id);
      `);
      v = 3;
    }

    if (v < 4) {
      // 거래량: 1분 단위로만 저장하고, 다른 기간은 합산해서 만든다
      this.sql.exec(`
        CREATE TABLE vol1m (
          stock_id INTEGER NOT NULL,
          t INTEGER NOT NULL,
          v INTEGER NOT NULL,
          PRIMARY KEY (stock_id, t)
        ) WITHOUT ROWID;
      `);
      v = 4;
    }

    if (v < 5) {
      this.sql.exec(`
        ALTER TABLE accounts ADD COLUMN stars INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE baselines (
          scope TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          nw INTEGER NOT NULL,
          stars INTEGER NOT NULL,
          PRIMARY KEY (scope, user_id)
        ) WITHOUT ROWID;
        CREATE TABLE lb_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE seasons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );
        CREATE TABLE lb_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          ended_at INTEGER NOT NULL,
          metric TEXT NOT NULL,
          rank INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          nick TEXT NOT NULL,
          value REAL NOT NULL,
          stars INTEGER NOT NULL
        );
      `);
      v = 5;
    }

    if (v < 6) {
      this.sql.exec(`
        ALTER TABLE accounts ADD COLUMN lottery_day INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE accounts ADD COLUMN lottery_count INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE lottery_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          count INTEGER NOT NULL,
          cost INTEGER NOT NULL,
          payout INTEGER NOT NULL
        );
      `);
      v = 6;
    }

    if (v < 7) {
      this.sql.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stock_id INTEGER NOT NULL,
          start_tick INTEGER NOT NULL,
          end_tick INTEGER NOT NULL,
          drift_ppm INTEGER NOT NULL,
          total_pct REAL NOT NULL,
          headline TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          created_by INTEGER NOT NULL
        );
        CREATE INDEX events_start ON events (start_tick);
      `);
      v = 7;
    }

    if (v < 8) {
      this.sql.exec(`
        CREATE TABLE reserves (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          stock_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          qty INTEGER NOT NULL,
          leverage INTEGER NOT NULL,
          cond TEXT NOT NULL,
          trig INTEGER NOT NULL,
          created_ts INTEGER NOT NULL,
          created_tick INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          note TEXT NOT NULL DEFAULT '',
          done_ts INTEGER,
          fill_price INTEGER
        );
        CREATE INDEX reserves_user ON reserves (user_id, id);
        CREATE INDEX reserves_status ON reserves (status);
        CREATE TABLE claims (
          user_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          ts INTEGER NOT NULL,
          PRIMARY KEY (user_id, key)
        ) WITHOUT ROWID;
      `);
      v = 8;
    }

    if (v < 9) {
      this.sql.exec(`
        CREATE TABLE puzzle_runs (
          user_id INTEGER PRIMARY KEY,
          bet INTEGER NOT NULL,
          cleared INTEGER NOT NULL,
          stage INTEGER NOT NULL,
          seed INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          phase TEXT NOT NULL
        );
        CREATE TABLE puzzle_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          bet INTEGER NOT NULL,
          cleared INTEGER NOT NULL,
          payout INTEGER NOT NULL
        );
        CREATE INDEX puzzle_log_user ON puzzle_log (user_id, id);
      `);
      v = 9;
    }

    if (v < 10) {
      this.sql.exec(`
        CREATE TABLE pt_upgrades (
          user_id INTEGER NOT NULL,
          id TEXT NOT NULL,
          level INTEGER NOT NULL,
          PRIMARY KEY (user_id, id)
        ) WITHOUT ROWID;
        CREATE TABLE pt_runs (
          user_id INTEGER PRIMARY KEY,
          run TEXT NOT NULL
        );
        CREATE TABLE pt_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          job TEXT NOT NULL,
          pay INTEGER NOT NULL
        );
        CREATE INDEX pt_log_user ON pt_log (user_id, id);
      `);
      v = 10;
    }

    if (v < 11) {
      this.sql.exec(`
        CREATE TABLE news_pass (
          user_id INTEGER PRIMARY KEY,
          until INTEGER NOT NULL
        );
      `);
      v = 11;
    }

    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", String(v));
  }

  private meta(key: string): string {
    return String(this.sql.exec("SELECT value FROM meta WHERE key=?", key).one().value);
  }

  // ── 라우팅 ──
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    this.bumpStat(p === "/ws" ? "wsc" : "api");
    try {
      if (p === "/ws") return await this.handleWs(req);
      if (req.method === "GET" && p === "/api/status") {
        return json({ maintenance: this.maintenanceInfo(), minVersion: this.minVersion() });
      }
      if (p.startsWith("/api/admin/") && p !== "/api/admin/season") return await this.handleAdmin(req, p);
      if (req.method === "GET" && p === "/api/me") return await this.handleMe(req);
      if (req.method === "POST" && p === "/api/register") return await this.handleRegister(req);
      if (req.method === "POST" && p === "/api/login") return await this.handleLogin(req);
      if (req.method === "POST" && p === "/api/logout") return await this.handleLogout(req);
      if (req.method === "POST" && p === "/api/claim-admin") return await this.handleClaimAdmin(req);
      if (req.method === "POST" && p === "/api/admin/season") return await this.handleSeasonAdmin(req);
    } catch (e) {
      console.error(e);
      return fail(500, "서버 오류가 발생했습니다.");
    }
    return fail(404, "not_found");
  }

  // ── 인증 ──
  private async userFromRequest(req: Request): Promise<(UserInfo & { banned: boolean }) | null> {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const hash = await sha256Hex(token);
    const row = this.sql
      .exec(
        `SELECT u.id, u.nickname, u.role, u.banned FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
        hash,
        Date.now(),
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      nickname: String(row.nickname),
      role: row.role === "admin" ? "admin" : "user",
      banned: Number(row.banned) === 1,
    };
  }

  private async startSession(userId: number, secure: boolean): Promise<string> {
    const token = newToken();
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.sql.exec(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      await sha256Hex(token),
      userId,
      now + SESSION_MS,
    );
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
  }

  private async body(req: Request): Promise<Record<string, unknown>> {
    try {
      const b = await req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async handleMe(req: Request): Promise<Response> {
    const u = await this.userFromRequest(req);
    if (!u || u.banned) return json({ user: null });
    return json({ user: { id: u.id, nickname: u.nickname, role: u.role } });
  }

  private async handleRegister(req: Request): Promise<Response> {
    const m = this.maintenanceInfo();
    if (m.on) return fail(503, m.message ? `점검 중입니다: ${m.message}` : "점검 중입니다. 잠시 후 다시 시도하세요.");
    const b = await this.body(req);
    const nickErr = validateNickname(b.nickname);
    if (nickErr) return fail(400, nickErr);
    const pwErr = validatePassword(b.password);
    if (pwErr) return fail(400, pwErr);
    const nickname = (b.nickname as string).trim();

    const exists = this.sql.exec("SELECT 1 FROM users WHERE nickname = ?", nickname).toArray().length > 0;
    if (exists) return fail(409, "이미 사용 중인 닉네임입니다.");

    const salt = newSalt();
    const pwHash = await hashPassword(b.password as string, salt);
    // await 사이에 같은 닉네임이 들어올 수 있으므로 UNIQUE 제약 위반도 처리
    let id: number;
    try {
      id = Number(
        this.sql
          .exec(
            "INSERT INTO users (nickname, pw_hash, salt, created_at) VALUES (?, ?, ?, ?) RETURNING id",
            nickname,
            pwHash,
            toHex(salt),
            Date.now(),
          )
          .one().id,
      );
    } catch {
      return fail(409, "이미 사용 중인 닉네임입니다.");
    }
    const cookie = await this.startSession(id, new URL(req.url).protocol === "https:");
    return json({ user: { id, nickname, role: "user" } }, 200, { "Set-Cookie": cookie });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const b = await this.body(req);
    if (typeof b.nickname !== "string" || typeof b.password !== "string") {
      return fail(400, "닉네임과 비밀번호를 입력하세요.");
    }
    const nickname = b.nickname.trim();
    const key = nickname.toLowerCase();
    const now = Date.now();
    const f = this.fails.get(key);
    if (f && now - f.first < FAIL_WINDOW_MS && f.n >= MAX_FAILS) {
      return fail(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.");
    }

    const row = this.sql
      .exec("SELECT id, nickname, pw_hash, salt, role, banned FROM users WHERE nickname = ?", nickname)
      .toArray()[0];
    // 계정이 없어도 같은 비용의 해시를 계산해 응답 시간 차이를 줄인다
    const salt = row ? fromHex(String(row.salt)) : newSalt();
    const hash = await hashPassword(b.password, salt);
    if (!row || !safeEqual(hash, String(row.pw_hash))) {
      const cur = f && now - f.first < FAIL_WINDOW_MS ? f : { n: 0, first: now };
      cur.n++;
      this.fails.set(key, cur);
      return fail(401, "닉네임 또는 비밀번호가 올바르지 않습니다.");
    }
    if (Number(row.banned) === 1) return fail(403, "정지된 계정입니다.");
    const maint = this.maintenanceInfo();
    if (maint.on && row.role !== "admin") {
      return fail(503, maint.message ? `점검 중입니다: ${maint.message}` : "점검 중입니다. 잠시 후 다시 시도하세요.");
    }

    this.fails.delete(key);
    const id = Number(row.id);
    const cookie = await this.startSession(id, new URL(req.url).protocol === "https:");
    const role = row.role === "admin" ? "admin" : "user";
    return json({ user: { id, nickname: String(row.nickname), role } }, 200, { "Set-Cookie": cookie });
  }

  private async handleLogout(req: Request): Promise<Response> {
    const token = readCookie(req, COOKIE);
    if (token) this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await sha256Hex(token));
    const secure = new URL(req.url).protocol === "https:";
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
    });
  }

  /** 로그인한 사용자가 ADMIN_KEY를 보내면 관리자 역할을 부여한다. */
  private async handleClaimAdmin(req: Request): Promise<Response> {
    const u = await this.userFromRequest(req);
    if (!u || u.banned) return fail(401, "로그인이 필요합니다.");
    // 키를 무작위로 대입하지 못하게 유저당 5분에 5번까지만 틀릴 수 있다
    const failKey = `admin:${u.id}`;
    const now = Date.now();
    const f = this.fails.get(failKey);
    if (f && now - f.first < FAIL_WINDOW_MS && f.n >= MAX_FAILS) return fail(429, "시도가 너무 많습니다. 잠시 후 다시 시도하세요.");
    const b = await this.body(req);
    // 붙여 넣을 때 따라오는 앞뒤 공백·줄바꿈은 무시한다
    const adminKey = this.env.ADMIN_KEY?.trim();
    if (!adminKey) {
      // 서버에 키가 없는 것은 입력 실수가 아니므로 따로 알려 준다 (틀린 시도로 세지 않는다)
      console.error("ADMIN_KEY 시크릿이 이 환경에 설정되어 있지 않습니다.");
      return fail(503, "서버에 관리자 키(ADMIN_KEY)가 설정되어 있지 않습니다. 시크릿 등록과 배포를 확인하세요.");
    }
    if (typeof b.key !== "string" || !safeEqual(b.key.trim(), adminKey)) {
      const cur = f && now - f.first < FAIL_WINDOW_MS ? f : { n: 0, first: now };
      cur.n++;
      this.fails.set(failKey, cur);
      return fail(403, "관리자 키가 올바르지 않습니다.");
    }
    this.fails.delete(failKey);
    this.sql.exec("UPDATE users SET role='admin' WHERE id = ?", u.id);
    return json({ ok: true });
  }

  // ── 리더보드 ──
  private lbMemo = new Map<string, LbBlob>();

  private lbMs(): number {
    return Number(this.env.LB_MS) || RULES.LEADERBOARD_MS;
  }

  private metaOpt(key: string): string | null {
    const r = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return r ? String(r.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  /** 거래를 한 번이라도 한 유저의 현재 순자산 (정지된 계정 제외) */
  private userSnaps(): UserSnap[] {
    const rows = this.sql
      .exec(
        `SELECT a.user_id AS id, a.cash AS cash, a.stars AS stars FROM accounts a
         JOIN users u ON u.id = a.user_id
         WHERE u.banned = 0 AND EXISTS (SELECT 1 FROM trades t WHERE t.user_id = a.user_id)`,
      )
      .toArray();
    const posBy = new Map<number, Position[]>();
    for (const r of this.sql.exec("SELECT user_id, stock_id, side, qty, cost, margin, leverage FROM positions").toArray()) {
      const id = Number(r.user_id);
      const list = posBy.get(id) ?? [];
      list.push(this.toPosition(r));
      posBy.set(id, list);
    }
    return rows.map((r) => ({
      id: Number(r.id),
      stars: Number(r.stars),
      nw: netWorth(Number(r.cash), posBy.get(Number(r.id)) ?? [], (s) => this.priceNow(s)),
    }));
  }

  /** 기준 시점 순자산. 기록이 없는 유저(기간 중 처음 거래)는 시작 자금을 기준으로 한다. */
  private baselines(scope: string, snaps: UserSnap[]): Map<number, Baseline> {
    const m = new Map<number, Baseline>();
    for (const r of this.sql.exec("SELECT user_id, nw, stars FROM baselines WHERE scope = ?", scope).toArray()) {
      m.set(Number(r.user_id), { nw: Number(r.nw), stars: Number(r.stars) });
    }
    for (const s of snaps) {
      if (m.has(s.id)) continue;
      const b = { nw: startCapital(s.stars), stars: s.stars };
      m.set(s.id, b);
      this.sql.exec("INSERT OR IGNORE INTO baselines (scope, user_id, nw, stars) VALUES (?, ?, ?, ?)", scope, s.id, b.nw, b.stars);
    }
    return m;
  }

  private snapshotBaselines(scope: string, snaps: UserSnap[]): void {
    this.sql.exec("DELETE FROM baselines WHERE scope = ?", scope);
    for (const s of snaps) {
      this.sql.exec("INSERT INTO baselines (scope, user_id, nw, stars) VALUES (?, ?, ?, ?)", scope, s.id, s.nw, s.stars);
    }
  }

  private readBlob(key: string): LbBlob | null {
    const memo = this.lbMemo.get(key);
    if (memo) return memo;
    const r = this.sql.exec("SELECT json FROM lb_cache WHERE key = ?", key).toArray()[0];
    if (!r) return null;
    const blob = JSON.parse(String(r.json)) as LbBlob;
    this.lbMemo.set(key, blob);
    return blob;
  }

  /** 순위 목록을 저장한다. 이전 순위(변동 화살표용)는 10분 이상 지난 스냅샷과 비교한다. */
  private writeBlob(key: string, lists: Record<Metric, { id: number; v: number }[]>, now: number): void {
    const old = this.readBlob(key);
    const m = {} as LbBlob["m"];
    const ranks = {} as Record<Metric, Record<string, number>>;
    for (const metric of METRICS) {
      const ranked = rankBy(lists[metric]);
      m[metric] = ranked.map((r) => [r.id, r.v]);
      ranks[metric] = Object.fromEntries(ranked.map((r) => [String(r.id), r.rank]));
    }
    let prev = old?.prev;
    let prevAt = old?.prevAt ?? now;
    if (!old || now - old.prevAt >= PREV_RANK_MS) {
      prev = old ? Object.fromEntries(METRICS.map((mt) => [mt, Object.fromEntries(old.m[mt].map((e, i) => [String(e[0]), i + 1]))])) as LbBlob["prev"] : ranks;
      prevAt = now;
    }
    const blob: LbBlob = { at: now, m, prev: prev ?? ranks, prevAt };
    this.sql.exec("INSERT OR REPLACE INTO lb_cache (key, json) VALUES (?, ?)", key, JSON.stringify(blob));
    this.lbMemo.set(key, blob);
  }

  private activeSeason(): { id: number; name: string; startedAt: number } | null {
    const id = Number(this.metaOpt("season_id") ?? 0);
    if (!id) return null;
    const r = this.sql.exec("SELECT name, started_at FROM seasons WHERE id = ?", id).toArray()[0];
    return r ? { id, name: String(r.name), startedAt: Number(r.started_at) } : null;
  }

  /** 기간이 끝났을 때 마지막으로 계산된 순위의 상위 N명을 보관한다 (명예의 전당) */
  private archive(kind: "season" | "week", label: string, key: string, endedAt: number): void {
    const blob = this.readBlob(key);
    if (!blob) return;
    for (const metric of METRICS) {
      const top = blob.m[metric].slice(0, RULES.HOF_TOP);
      top.forEach((e, i) => {
        const u = this.sql.exec("SELECT u.nickname AS nick, a.stars AS stars FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.id = ?", e[0]).toArray()[0];
        this.sql.exec(
          "INSERT INTO lb_history (kind, label, ended_at, metric, rank, user_id, nick, value, stars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          kind, label, endedAt, metric, i + 1, e[0], String(u?.nick ?? "?"), e[1], Number(u?.stars ?? 0),
        );
      });
    }
  }

  /** 매분(alarm): 순위를 계산해 저장한다. 요청 시에는 저장된 값을 읽기만 한다. */
  private runLeaderboard(): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const snaps = this.userSnaps();

      // 주 경계(한국 시간 월요일 0시): 지난 주 순위 보관 + 새 주 기준 순자산 기록
      const weekId = String(weekIdOf(now));
      const curWeek = this.metaOpt("week_id");
      if (curWeek !== weekId) {
        if (curWeek) {
          this.archive("week", weekLabel(Number(curWeek)), "week", now);
          this.sql.exec("DELETE FROM baselines WHERE scope = ?", `week:${curWeek}`);
        }
        this.snapshotBaselines(`week:${weekId}`, snaps);
        this.setMeta("week_id", weekId);
      }

      const lists = (fn: (s: UserSnap) => Values | null) => {
        const out: Record<Metric, { id: number; v: number }[]> = { nw: [], rate: [], honor: [] };
        for (const s of snaps) {
          const v = fn(s);
          if (!v) continue;
          for (const mt of METRICS) out[mt].push({ id: s.id, v: v[mt] });
        }
        return out;
      };

      this.writeBlob("live", lists((s) => liveValues(s)), now);

      const wb = this.baselines(`week:${weekId}`, snaps);
      this.writeBlob("week", lists((s) => gainValues(s, wb.get(s.id)!)), now);

      const season = this.activeSeason();
      if (season) {
        const sb = this.baselines(`season:${season.id}`, snaps);
        this.writeBlob("season", lists((s) => gainValues(s, sb.get(s.id)!)), now);
      }

      // 역대: 개인 최고 기록. 바뀐 때만 저장한다.
      const peakRow = this.sql.exec("SELECT json FROM lb_cache WHERE key = 'peaks'").toArray()[0];
      const peaks: Record<string, Values> = peakRow ? JSON.parse(String(peakRow.json)) : {};
      let dirty = false;
      for (const s of snaps) {
        const r = peakUpdate(peaks[String(s.id)], liveValues(s));
        if (r.changed) { peaks[String(s.id)] = r.peak; dirty = true; }
      }
      if (dirty) this.sql.exec("INSERT OR REPLACE INTO lb_cache (key, json) VALUES ('peaks', ?)", JSON.stringify(peaks));
      this.writeBlob("all", lists((s) => peaks[String(s.id)] ?? null), now);
    });
    this.broadcast({ t: "lbTick" });
  }

  startSeason(name: string): { ok: boolean; error?: string } {
    if (this.activeSeason()) return { ok: false, error: "이미 진행 중인 시즌이 있습니다." };
    this.ctx.storage.transactionSync(() => {
      const id = Number(
        this.sql.exec("INSERT INTO seasons (name, started_at) VALUES (?, ?) RETURNING id", name, Date.now()).one().id,
      );
      this.snapshotBaselines(`season:${id}`, this.userSnaps());
      this.setMeta("season_id", String(id));
    });
    this.runLeaderboard();
    return { ok: true };
  }

  endSeason(): { ok: boolean; error?: string } {
    const season = this.activeSeason();
    if (!season) return { ok: false, error: "진행 중인 시즌이 없습니다." };
    this.runLeaderboard(); // 마지막 순위를 최신으로
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.archive("season", season.name, "season", now);
      this.sql.exec("UPDATE seasons SET ended_at = ? WHERE id = ?", now, season.id);
      this.sql.exec("DELETE FROM baselines WHERE scope = ?", `season:${season.id}`);
      this.sql.exec("DELETE FROM lb_cache WHERE key = 'season'");
      this.lbMemo.delete("season");
      this.setMeta("season_id", "0");
    });
    this.broadcast({ t: "lbTick" });
    return { ok: true };
  }

  private async handleSeasonAdmin(req: Request): Promise<Response> {
    const u = await this.userFromRequest(req);
    if (!u || u.banned || u.role !== "admin") return fail(403, "관리자만 사용할 수 있습니다.");
    const b = await this.body(req);
    if (b.action === "start") {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (name.length < 1 || name.length > 30) return fail(400, "시즌 이름은 1~30자여야 합니다.");
      const r = this.startSeason(name);
      return r.ok ? json({ ok: true }) : fail(409, r.error ?? "실패");
    }
    if (b.action === "end") {
      const r = this.endSeason();
      return r.ok ? json({ ok: true }) : fail(409, r.error ?? "실패");
    }
    return fail(400, "action은 start 또는 end 입니다.");
  }

  private handleLb(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "lb" }>): void {
    if (!PERIODS.includes(msg.period) || !METRICS.includes(msg.metric)) return;
    const season = this.activeSeason();
    let blob = this.readBlob(msg.period);
    if (!blob && (msg.period !== "season" || season)) {
      this.runLeaderboard();
      blob = this.readBlob(msg.period);
    }
    const seasonInfo = season ? { name: season.name, startedAt: season.startedAt } : null;
    const list = blob?.m[msg.metric] ?? [];
    const top = list.slice(0, RULES.LB_TOP);
    const meIdx = list.findIndex((e) => e[0] === att.userId);
    const ids = new Set(top.map((e) => e[0]));
    if (meIdx >= 0) ids.add(att.userId);
    const info = new Map<number, { nick: string; stars: number }>();
    if (ids.size) {
      const marks = [...ids].map(() => "?").join(",");
      for (const r of this.sql
        .exec(`SELECT u.id AS id, u.nickname AS nick, a.stars AS stars FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.id IN (${marks})`, ...ids)
        .toArray()) {
        info.set(Number(r.id), { nick: String(r.nick), stars: Number(r.stars) });
      }
    }
    const mk = (e: [number, number], rank: number): LbEntry => {
      const p = blob?.prev[msg.metric]?.[String(e[0])];
      return { rank, nick: info.get(e[0])?.nick ?? "?", value: e[1], stars: info.get(e[0])?.stars ?? 0, prev: p === undefined ? null : p, me: e[0] === att.userId };
    };
    ws.send(
      JSON.stringify({
        t: "lb", period: msg.period, metric: msg.metric, at: blob?.at ?? 0, total: list.length,
        entries: top.map((e, i) => mk(e, i + 1)),
        me: meIdx >= 0 ? mk(list[meIdx], meIdx + 1) : null,
        season: seasonInfo,
      } satisfies ServerMsg),
    );
  }

  private handleHof(ws: WebSocket): void {
    const rows = this.sql
      .exec("SELECT kind, label, ended_at, metric, rank, nick, value, stars FROM lb_history ORDER BY ended_at DESC, rank ASC LIMIT 1500")
      .toArray();
    const groups = new Map<string, HofGroup & { kind: string }>();
    for (const r of rows) {
      const k = `${r.kind}|${r.label}|${r.ended_at}`;
      let g = groups.get(k);
      if (!g) {
        g = { kind: String(r.kind), label: String(r.label), endedAt: Number(r.ended_at), top: { nw: [], rate: [], honor: [] } };
        groups.set(k, g);
      }
      g.top[r.metric as Metric].push({ rank: Number(r.rank), nick: String(r.nick), value: Number(r.value), stars: Number(r.stars) });
    }
    const all = [...groups.values()];
    const strip = ({ kind: _k, ...g }: HofGroup & { kind: string }): HofGroup => g;
    ws.send(
      JSON.stringify({
        t: "hof",
        seasons: all.filter((g) => g.kind === "season").map(strip),
        weeks: all.filter((g) => g.kind === "week").slice(0, 4).map(strip),
      } satisfies ServerMsg),
    );
  }

  // ── 관리자 · 점검 · 통계 ──
  private stats: { day: number; api: number; wsc: number; wsm: number; alarms: number } | null = null;

  private bumpStat(k: "api" | "wsc" | "wsm" | "alarms"): void {
    const today = this.today();
    if (!this.stats) {
      const raw = this.metaOpt("stats");
      this.stats = raw ? JSON.parse(raw) : { day: today, api: 0, wsc: 0, wsm: 0, alarms: 0 };
    }
    if (this.stats!.day !== today) this.stats = { day: today, api: 0, wsc: 0, wsm: 0, alarms: 0 };
    this.stats![k]++;
  }

  private flushStats(): void {
    if (this.stats) this.setMeta("stats", JSON.stringify(this.stats));
  }

  /** 오늘 요청 수 추정: 무료 플랜 한도(하루 10만)와 비교하는 용도 */
  private statsEstimate() {
    const s = this.stats ?? (this.metaOpt("stats") ? JSON.parse(this.metaOpt("stats")!) : { day: this.today(), api: 0, wsc: 0, wsm: 0, alarms: 0 });
    const cur = s.day === this.today() ? s : { day: this.today(), api: 0, wsc: 0, wsm: 0, alarms: 0 };
    return {
      api: cur.api,
      wsConnects: cur.wsc,
      wsMessages: cur.wsm,
      alarms: cur.alarms,
      workerRequests: cur.api + cur.wsc,
      doRequests: cur.api + cur.wsc + Math.ceil(cur.wsm / 20) + cur.alarms, // WebSocket 수신 메시지는 20개당 1요청
      limit: 100_000,
    };
  }

  /** 점검 중이거나 클라이언트 버전이 낮으면 거래성 요청을 막는 문구를 돌려준다. (관리자는 점검 중에도 사용 가능) */
  private gate(att: Attachment): string | null {
    const m = this.maintenanceInfo();
    if (m.on && att.role !== "admin") return m.message ? `점검 중입니다: ${m.message}` : "점검 중입니다. 잠시 후 다시 이용해 주세요.";
    if ((att.v ?? CLIENT_VERSION) < this.minVersion()) return "새 버전이 나왔습니다. 페이지를 새로고침해 주세요.";
    return null;
  }

  private async adminUser(req: Request): Promise<(UserInfo & { banned: boolean }) | null> {
    const u = await this.userFromRequest(req);
    return u && !u.banned && u.role === "admin" ? u : null;
  }

  private eventRows(): Record<string, unknown>[] {
    this.epochCache ??= Number(this.meta("epoch"));
    const cur = this.currentTick();
    return this.sql
      .exec("SELECT id, stock_id, start_tick, end_tick, total_pct, headline, created_at FROM events ORDER BY start_tick DESC LIMIT 30")
      .toArray()
      .map((r) => {
        const start = Number(r.start_tick);
        const end = Number(r.end_tick);
        return {
          id: Number(r.id),
          stock: Number(r.stock_id),
          startAt: this.epochCache! + start * RULES.TICK_MS,
          endAt: this.epochCache! + end * RULES.TICK_MS,
          durationMin: Math.round(((end - start) * RULES.TICK_MS) / 60_000),
          totalPct: Number(r.total_pct),
          headline: String(r.headline),
          state: cur < start ? "scheduled" : cur < end ? "active" : "done",
        };
      });
  }

  private async handleAdmin(req: Request, p: string): Promise<Response> {
    const admin = await this.adminUser(req);
    if (!admin) return fail(403, "관리자만 사용할 수 있습니다.");

    if (req.method === "GET" && p === "/api/admin/overview") {
      const liveBlob = this.readBlob("live");
      const flags: { nick: string; rate: number; nw: number }[] = [];
      if (liveBlob) {
        const nwOf = new Map(liveBlob.m.nw);
        for (const [id, rate] of liveBlob.m.rate) {
          if (rate < RULES.ABNORMAL_RATE) break; // 수익률 내림차순이라 여기서 끝
          const u = this.sql.exec("SELECT nickname FROM users WHERE id = ?", id).toArray()[0];
          flags.push({ nick: String(u?.nickname ?? "?"), rate, nw: nwOf.get(id) ?? 0 });
        }
      }
      const season = this.activeSeason();
      const counts = this.sql
        .exec("SELECT COUNT(*) AS total, COALESCE(SUM(banned), 0) AS banned FROM users")
        .one();
      return json({
        online: this.onlineCount(),
        sockets: this.openSockets().length,
        users: Number(counts.total),
        banned: Number(counts.banned),
        requests: this.statsEstimate(),
        maintenance: this.maintenanceInfo(),
        minVersion: this.minVersion(),
        clientVersion: CLIENT_VERSION,
        season,
        events: this.eventRows(),
        flags,
        now: Date.now(),
      });
    }

    const b = req.method === "POST" ? await this.body(req) : {};

    // 이벤트는 서버가 자동으로 만든다 (maybeSpawnEvent). 운영자가 등록하거나 지울 수 없다.
    if (req.method === "POST" && (p === "/api/admin/event" || p === "/api/admin/event/delete")) {
      return fail(410, "이벤트는 자동으로 발생합니다. 운영자가 등록하거나 삭제할 수 없습니다.");
    }

    if (req.method === "POST" && p === "/api/admin/maintenance") {
      const info: MaintenanceInfo = { on: b.on === true, message: typeof b.message === "string" ? b.message.trim().slice(0, 200) : "" };
      this.setMeta("maintenance", JSON.stringify(info));
      this.broadcast({ t: "maintenance", on: info.on, message: info.message });
      return json({ ok: true, maintenance: info });
    }

    if (req.method === "POST" && p === "/api/admin/min-version") {
      const v = Math.floor(Number(b.version));
      if (!Number.isFinite(v) || v < 0 || v > 1_000_000) return fail(400, "버전은 0 이상의 정수여야 합니다.");
      this.setMeta("min_version", String(v));
      return json({ ok: true, minVersion: v });
    }

    if (req.method === "POST" && p === "/api/admin/announce") {
      const msg = parseAnnounce(b.message);
      if (!msg.ok) return fail(400, msg.error);
      this.broadcast({ t: "announce", message: msg.value });
      console.log("admin announce", { admin: admin.id, message: msg.value });
      return json({ ok: true, online: this.onlineCount() });
    }

    // 현금 조정은 관리자 계정(본인 포함)에도 할 수 있어서, 아래의 유저 관리와 따로 둔다.
    if (req.method === "POST" && p === "/api/admin/cash") {
      const id = Number(b.id);
      if (this.sql.exec("SELECT 1 FROM users WHERE id = ?", id).toArray().length === 0) return fail(404, "없는 유저입니다.");
      let result: ReturnType<typeof adjustCash> = { ok: false, error: "처리하지 못했습니다." };
      let events: LiquidationEvent[] = [];
      let before = 0;
      this.ctx.storage.transactionSync(() => {
        events = this.liquidateUser(id); // 밀린 청산을 먼저 반영한 잔고를 기준으로 한다
        before = this.getCash(id);
        result = adjustCash(before, b.mode, b.amount);
        if (result.ok) this.setCash(id, result.value);
      });
      this.notifyLiquidations(events);
      const r = result as ReturnType<typeof adjustCash>;
      if (!r.ok) return fail(400, r.error);
      console.log("admin cash", { admin: admin.id, user: id, before, after: r.value });
      const account = JSON.stringify(this.accountMsg(id));
      for (const w of this.socketsOf(id)) w.send(account);
      return json({ ok: true, cash: r.value });
    }

    if (req.method === "GET" && p === "/api/admin/users") {
      const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; // LIKE 특수문자는 지우지 않고 이스케이프
      const rows = this.sql
        .exec(
          `SELECT u.id, u.nickname, u.role, u.banned, u.created_at, a.cash, a.stars FROM users u
           LEFT JOIN accounts a ON a.user_id = u.id WHERE u.nickname LIKE ? ESCAPE '\\' ORDER BY u.id DESC LIMIT 50`,
          like,
        )
        .toArray();
      const online = new Set(this.openSockets().map((w) => (w.deserializeAttachment() as Attachment | null)?.userId));
      return json({
        users: rows.map((r) => ({
          id: Number(r.id), nickname: String(r.nickname), role: String(r.role), banned: Number(r.banned) === 1,
          createdAt: Number(r.created_at), cash: r.cash === null ? null : Number(r.cash), stars: Number(r.stars ?? 0),
          online: online.has(Number(r.id)),
        })),
      });
    }

    if (req.method === "POST" && p === "/api/admin/user") {
      const id = Number(b.id);
      const target = this.sql.exec("SELECT id, nickname, role FROM users WHERE id = ?", id).toArray()[0];
      if (!target) return fail(404, "없는 유저입니다.");
      if (target.role === "admin") return fail(403, "관리자 계정은 변경할 수 없습니다.");
      if (b.action === "ban" || b.action === "unban") {
        const ban = b.action === "ban";
        this.sql.exec("UPDATE users SET banned = ? WHERE id = ?", ban ? 1 : 0, id);
        if (ban) {
          this.sql.exec("DELETE FROM sessions WHERE user_id = ?", id);
          for (const w of this.socketsOf(id)) {
            try { w.close(4001, "banned"); } catch { /* 이미 닫힘 */ }
          }
          this.broadcastOnline();
        }
        return json({ ok: true });
      }
      if (b.action === "rename") {
        const err = validateNickname(b.nickname);
        if (err) return fail(400, err);
        const nick = (b.nickname as string).trim();
        const dup = this.sql.exec("SELECT 1 FROM users WHERE nickname = ? AND id <> ?", nick, id).toArray().length > 0;
        if (dup) return fail(409, "이미 사용 중인 닉네임입니다.");
        this.sql.exec("UPDATE users SET nickname = ? WHERE id = ?", nick, id);
        for (const w of this.socketsOf(id)) {
          const a = w.deserializeAttachment() as Attachment;
          w.serializeAttachment({ ...a, nickname: nick } satisfies Attachment);
        }
        return json({ ok: true });
      }
      return fail(400, "알 수 없는 작업입니다.");
    }

    return fail(404, "not_found");
  }

  // ── 예약 주문 ──
  private reserveItem(r: Record<string, SqlStorageValue>): ReserveItem {
    return {
      id: Number(r.id),
      stock: Number(r.stock_id),
      action: r.action as OrderAction,
      qty: Number(r.qty),
      leverage: Number(r.leverage),
      cond: r.cond as ReserveCond,
      trigger: Number(r.trig),
      status: r.status as ReserveStatus,
      note: String(r.note),
      ts: Number(r.created_ts),
      doneTs: r.done_ts === null ? null : Number(r.done_ts),
      fillPrice: r.fill_price === null ? null : Number(r.fill_price),
    };
  }

  private finishReserve(id: number, userId: number, status: "filled" | "failed" | "canceled", note: string, price: number | null, done: ReserveDone[]): void {
    this.sql.exec("UPDATE reserves SET status = ?, note = ?, done_ts = ?, fill_price = ? WHERE id = ?", status, note, Date.now(), price, id);
    done.push({ userId, item: this.reserveItem(this.sql.exec("SELECT * FROM reserves WHERE id = ?", id).one()) });
  }

  private hasPendingReserves(): boolean {
    return this.sql.exec("SELECT 1 FROM reserves WHERE status = 'pending' LIMIT 1").toArray().length > 0;
  }

  /**
   * 대기 중인 예약 중 조건이 맞은 것을 체결한다. 트랜잭션 안에서 호출한다.
   * paths: 종목별 가격 구간. 실시간은 현재 tick 하나, 체크포인트는 직전 체크포인트 이후 전체 구간이라서
   * 접속하지 않은 동안 조건이 맞았어도 그 tick의 가격으로 체결된다. 체결은 tick 순서대로 한다.
   * 강제 청산 조건이 더 먼저 걸린 포지션의 손절·익절은 체결하지 않는다 (청산이 우선).
   */
  private processReserves(paths: Map<number, { from: number; prices: number[] }>, done: ReserveDone[]): void {
    const rows = this.sql.exec("SELECT * FROM reserves WHERE status = 'pending' ORDER BY id").toArray();
    if (rows.length === 0) return;
    const now = Date.now();
    const hits: { r: Record<string, SqlStorageValue>; tick: number; price: number }[] = [];
    const posRowOf = (userId: number, stockId: number, action: OrderAction) =>
      this.sql
        .exec(
          "SELECT stock_id, side, qty, cost, margin, leverage, opened_tick FROM positions WHERE user_id = ? AND stock_id = ? AND side = ?",
          userId, stockId, action === "sell" ? "long" : "short",
        )
        .toArray()[0];

    for (const r of rows) {
      const id = Number(r.id), userId = Number(r.user_id), stockId = Number(r.stock_id);
      const action = r.action as OrderAction;
      if (now - Number(r.created_ts) > RULES.RESERVE_TTL_MS) {
        this.finishReserve(id, userId, "canceled", "기간이 지나 취소되었습니다.", null, done);
        continue;
      }
      if (isClosing(action) && !posRowOf(userId, stockId, action)) {
        this.finishReserve(id, userId, "failed", "정리할 포지션이 없어 취소되었습니다.", null, done);
        continue;
      }
      const path = paths.get(stockId);
      if (!path) continue;
      const h = firstTrigger(r.cond as ReserveCond, Number(r.trig), path.prices, path.from, Number(r.created_tick));
      if (h) hits.push({ r, ...h });
    }

    hits.sort((a, b) => a.tick - b.tick || Number(a.r.id) - Number(b.r.id));
    for (const h of hits) {
      const id = Number(h.r.id), userId = Number(h.r.user_id), stockId = Number(h.r.stock_id);
      const action = h.r.action as OrderAction;
      if (isClosing(action)) {
        const posRow = posRowOf(userId, stockId, action);
        if (!posRow) {
          this.finishReserve(id, userId, "failed", "정리할 포지션이 없어 취소되었습니다.", null, done);
          continue;
        }
        const path = paths.get(stockId)!;
        const liq = firstLiquidation(this.toPosition(posRow), path.prices, path.from, Number(posRow.opened_tick));
        if (liq && liq.tick <= h.tick) continue; // 청산이 먼저: 이 예약은 포지션이 사라진 뒤 정리된다
      }
      const res = this.applyOrder(userId, stockId, action, Number(h.r.qty), Number(h.r.leverage), h.price, h.tick);
      if (res.ok) this.finishReserve(id, userId, "filled", "", h.price, done);
      else this.finishReserve(id, userId, "failed", res.error, null, done);
    }
  }

  /** 예약 결과를 해당 유저에게 알리고, 체결은 체결 피드에도 올린다. */
  private notifyReserves(done: ReserveDone[]): void {
    const users = new Set<number>();
    for (const d of done) {
      users.add(d.userId);
      const msg = JSON.stringify({ t: "reserveDone", item: d.item } satisfies ServerMsg);
      for (const w of this.socketsOf(d.userId)) w.send(msg);
      if (d.item.status === "filled") {
        const nick = this.sql.exec("SELECT nickname FROM users WHERE id = ?", d.userId).toArray()[0]?.nickname;
        this.broadcast({
          t: "fill",
          item: { ts: Date.now(), nick: String(nick ?? "?"), stock: d.item.stock, action: d.item.action, qty: d.item.qty, price: d.item.fillPrice ?? 0 },
        });
      }
    }
    for (const id of users) {
      const msg = JSON.stringify(this.accountMsg(id));
      for (const w of this.socketsOf(id)) w.send(msg);
    }
  }

  private sendReserves(ws: WebSocket, userId: number): void {
    const items = this.sql
      .exec("SELECT * FROM reserves WHERE user_id = ? ORDER BY (status = 'pending') DESC, id DESC LIMIT ?", userId, RULES.RESERVE_MAX + RULES.RESERVE_KEEP)
      .toArray()
      .map((r) => this.reserveItem(r));
    ws.send(JSON.stringify({ t: "reserves", items } satisfies ServerMsg));
  }

  private handleReserve(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "reserve" }>): void {
    const fail = (error: string) => ws.send(JSON.stringify({ t: "reserve", ok: false, error } satisfies ServerMsg));
    if (this.rateLimited(att.userId)) return fail("너무 빠릅니다. 잠시 후 다시 시도하세요.");
    const p = parseReserve(msg as unknown as Record<string, unknown>);
    if (!p.ok) return fail(p.error);
    const v = p.value;
    if (!STOCKS.some((s) => s.id === v.stock)) return fail("없는 종목입니다.");

    let out: ServerMsg = { t: "reserve", ok: false, error: "처리하지 못했습니다." };
    this.ctx.storage.transactionSync(() => {
      const pending = Number(this.sql.exec("SELECT COUNT(*) AS n FROM reserves WHERE user_id = ? AND status = 'pending'", att.userId).one().n);
      if (pending >= RULES.RESERVE_MAX) {
        out = { t: "reserve", ok: false, error: `예약은 최대 ${RULES.RESERVE_MAX}건까지 걸 수 있습니다.` };
        return;
      }
      if (isClosing(v.action)) {
        const pos = this.sql
          .exec("SELECT qty FROM positions WHERE user_id = ? AND stock_id = ? AND side = ?", att.userId, v.stock, v.action === "sell" ? "long" : "short")
          .toArray()[0];
        if (!pos) {
          out = { t: "reserve", ok: false, error: v.action === "sell" ? "보유한 수량이 없습니다." : "공매도 포지션이 없습니다." };
          return;
        }
        if (v.qty > Number(pos.qty)) {
          out = { t: "reserve", ok: false, error: "보유 수량보다 많습니다." };
          return;
        }
      }
      this.sql.exec(
        "INSERT INTO reserves (user_id, stock_id, action, qty, leverage, cond, trig, created_ts, created_tick) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        att.userId, v.stock, v.action, v.qty, v.leverage, v.cond, v.trigger, Date.now(), this.currentTick(),
      );
      const id = Number(this.sql.exec("SELECT last_insert_rowid() AS id").one().id);
      // 끝난 예약은 최근 RESERVE_KEEP건만 남긴다
      this.sql.exec(
        `DELETE FROM reserves WHERE user_id = ? AND status != 'pending'
         AND id NOT IN (SELECT id FROM reserves WHERE user_id = ? AND status != 'pending' ORDER BY id DESC LIMIT ?)`,
        att.userId, att.userId, RULES.RESERVE_KEEP,
      );
      out = { t: "reserve", ok: true, item: this.reserveItem(this.sql.exec("SELECT * FROM reserves WHERE id = ?", id).one()) };
    });
    ws.send(JSON.stringify(out));
  }

  private handleCancelReserve(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "cancelReserve" }>): void {
    const id = Number(msg.id);
    let ok = false;
    this.ctx.storage.transactionSync(() => {
      const r = this.sql.exec("SELECT id FROM reserves WHERE id = ? AND user_id = ? AND status = 'pending'", id, att.userId).toArray()[0];
      if (!r) return;
      this.sql.exec("UPDATE reserves SET status = 'canceled', note = '직접 취소했습니다.', done_ts = ? WHERE id = ?", Date.now(), id);
      ok = true;
    });
    ws.send(JSON.stringify({ t: "cancelReserve", ok, id, error: ok ? undefined : "취소할 수 없는 예약입니다." } satisfies ServerMsg));
    this.sendReserves(ws, att.userId);
  }

  // ── 성적표 · 미션 · 업적 ──
  private userTradeRows(userId: number, sinceTs = 0): TradeRow[] {
    return this.sql
      .exec(
        "SELECT stock_id, action, qty, price, fee, pnl, leverage, ts FROM trades WHERE user_id = ? AND ts >= ? ORDER BY id DESC LIMIT 50000",
        userId, sinceTs,
      )
      .toArray()
      .map((r) => ({
        stock: Number(r.stock_id), action: String(r.action), qty: Number(r.qty), price: Number(r.price),
        fee: Number(r.fee), pnl: r.pnl === null ? null : Number(r.pnl), leverage: Number(r.leverage), ts: Number(r.ts),
      }));
  }

  private lotterySummary(userId: number, sinceTs = 0): LotterySummary {
    const r = this.sql
      .exec(
        "SELECT COALESCE(SUM(count), 0) AS n, COALESCE(SUM(cost), 0) AS c, COALESCE(SUM(payout), 0) AS p, COALESCE(MAX(payout), 0) AS m FROM lottery_log WHERE user_id = ? AND ts >= ?",
        userId, sinceTs,
      )
      .one();
    return { tickets: Number(r.n), cost: Number(r.c), payout: Number(r.p), maxPayout: Number(r.m) };
  }

  private handleStats(ws: WebSocket, att: Attachment): void {
    if (this.rateLimited(att.userId)) return;
    const stats = summarize(this.userTradeRows(att.userId), this.lotterySummary(att.userId));
    ws.send(JSON.stringify({ t: "stats", stats } satisfies ServerMsg));
  }

  private questsMsg(userId: number): ServerMsg {
    const day = this.today();
    const dayStart = day * 86_400_000 - KST_MS;
    const claimed = new Set(
      this.sql.exec("SELECT key FROM claims WHERE user_id = ? AND key LIKE ?", userId, `d:${day}:%`).toArray().map((r) => String(r.key)),
    );
    const missions = missionViews(day, this.userTradeRows(userId, dayStart), this.lotterySummary(userId, dayStart), claimed);
    const achievements = achievementViews(this.userTradeRows(userId), this.lotterySummary(userId));
    return { t: "quests", day, missions, achievements };
  }

  private handleQuests(ws: WebSocket, att: Attachment): void {
    if (this.rateLimited(att.userId)) return;
    ws.send(JSON.stringify(this.questsMsg(att.userId)));
  }

  private handleClaim(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "claim" }>): void {
    const fail = (error: string) => ws.send(JSON.stringify({ t: "claim", ok: false, error } satisfies ServerMsg));
    if (this.rateLimited(att.userId)) return fail("너무 빠릅니다. 잠시 후 다시 시도하세요.");
    const id = String(msg.id);
    let out: ServerMsg = { t: "claim", ok: false, error: "처리하지 못했습니다." };
    this.ctx.storage.transactionSync(() => {
      const q = this.questsMsg(att.userId);
      const m = q.t === "quests" ? q.missions.find((x) => x.id === id) : undefined;
      if (!m) { out = { t: "claim", ok: false, error: "오늘의 미션이 아닙니다." }; return; }
      if (m.claimed) { out = { t: "claim", ok: false, error: "이미 보상을 받았습니다." }; return; }
      if (m.progress < m.target) { out = { t: "claim", ok: false, error: "아직 달성하지 못했습니다." }; return; }
      this.sql.exec("INSERT INTO claims (user_id, key, ts) VALUES (?, ?, ?)", att.userId, claimKey(this.today(), id), Date.now());
      this.setCash(att.userId, this.getCash(att.userId) + m.reward);
      out = { t: "claim", ok: true, id, amount: m.reward };
    });
    ws.send(JSON.stringify(out));
    ws.send(JSON.stringify(this.questsMsg(att.userId)));
    ws.send(JSON.stringify(this.accountMsg(att.userId)));
  }

  // ── 복권 · 프레스티지 ──
  /** 즉석 복권: 장수·잔고·일일 한도 검사, 추첨, 정산을 한 트랜잭션에서 서버가 처리한다. */
  private handleLottery(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "lottery" }>): void {
    const fail = (error: string) => ws.send(JSON.stringify({ t: "lottery", ok: false, error } satisfies ServerMsg));
    const count = Number(msg.count);
    if (!Number.isInteger(count) || count < 1 || count > RULES.LOTTERY_PER_DAY) return fail("장수가 올바르지 않습니다.");
    if (this.rateLimited(att.userId)) return fail("너무 빠릅니다. 잠시 후 다시 시도하세요.");

    let out: ServerMsg | null = null;
    let events: LiquidationEvent[] = [];
    let bigWin = 0;
    this.ctx.storage.transactionSync(() => {
      events = this.liquidateUser(att.userId);
      const cash = this.getCash(att.userId);
      const a = this.sql.exec("SELECT lottery_day, lottery_count FROM accounts WHERE user_id = ?", att.userId).one();
      const today = this.today();
      const used = Number(a.lottery_day) === today ? Number(a.lottery_count) : 0;
      const left = RULES.LOTTERY_PER_DAY - used;
      if (left <= 0) { out = { t: "lottery", ok: false, error: "오늘 살 수 있는 복권을 모두 샀습니다." }; return; }
      if (count > left) { out = { t: "lottery", ok: false, error: `오늘은 ${left}장까지 더 살 수 있습니다.` }; return; }
      const cost = count * RULES.LOTTERY_PRICE;
      if (cost > cash) { out = { t: "lottery", ok: false, error: "잔고가 부족합니다." }; return; }

      // 결과는 서버 난수로만 정한다 (클라이언트는 결과를 알려 주기만 받는다)
      const payouts: number[] = [];
      for (let i = 0; i < count; i++) payouts.push(prizeForRoll(randomBelow(LOTTERY_TOTAL_WEIGHT)));
      const payout = payouts.reduce((s, p) => s + p, 0);
      this.sql.exec(
        "UPDATE accounts SET cash = ?, lottery_day = ?, lottery_count = ? WHERE user_id = ?",
        cash - cost + payout, today, used + count, att.userId,
      );
      this.sql.exec("INSERT INTO lottery_log (user_id, ts, count, cost, payout) VALUES (?, ?, ?, ?, ?)", att.userId, Date.now(), count, cost, payout);
      bigWin = Math.max(0, ...payouts);
      if (bigWin >= RULES.LOTTERY_FEED_MIN) this.recordTrade(att.userId, 0, "lottery", bigWin, 0, 0, bigWin - cost, 1);
      out = { t: "lottery", ok: true, payouts, cost, payout, left: left - count };
    });

    this.notifyLiquidations(events);
    ws.send(JSON.stringify(out ?? { t: "lottery", ok: false, error: "처리하지 못했습니다." }));
    ws.send(JSON.stringify(this.accountMsg(att.userId)));
    if (bigWin >= RULES.LOTTERY_FEED_MIN) {
      this.broadcast({ t: "fill", item: { ts: Date.now(), nick: att.nickname, stock: 0, action: "lottery", qty: bigWin, price: 0 } });
    }
  }

  // ── 알바 ──
  private ptLevels(userId: number): Levels {
    const out: Levels = {};
    for (const r of this.sql.exec("SELECT id, level FROM pt_upgrades WHERE user_id = ?", userId).toArray()) {
      const def = upgradeDef(String(r.id));
      if (def) out[def.id] = Math.min(def.max, Math.max(0, Number(r.level)));
    }
    return out;
  }

  private loadPt(userId: number): PtRun | null {
    const r = this.sql.exec("SELECT run FROM pt_runs WHERE user_id = ?", userId).toArray()[0];
    if (!r) return null;
    try {
      return JSON.parse(String(r.run)) as PtRun;
    } catch {
      this.sql.exec("DELETE FROM pt_runs WHERE user_id = ?", userId); // 깨진 기록은 버린다
      return null;
    }
  }

  private savePt(userId: number, run: PtRun): void {
    this.sql.exec("INSERT OR REPLACE INTO pt_runs (user_id, run) VALUES (?, ?)", userId, JSON.stringify(run));
  }

  /** 근무를 끝내고 수입을 계좌에 넣는다. (트랜잭션 안에서 호출) */
  private finishPt(userId: number, end: PtEnd): void {
    this.sql.exec("DELETE FROM pt_runs WHERE user_id = ?", userId);
    if (end.pay > 0) this.setCash(userId, this.getCash(userId) + end.pay);
    this.sql.exec("INSERT INTO pt_log (user_id, ts, job, pay) VALUES (?, ?, ?, ?)", userId, Date.now(), end.job, end.pay);
  }

  private ptView(userId: number, run: PtRun | null, end: PtEnd | null, info: PtInfo | null, now: number): PtView {
    const levels: Record<string, number> = { ...this.ptLevels(userId) };
    if (run) return { phase: "play", levels, run: ptViewData(run, now, memorySeq), end: null, info };
    if (end) return { phase: "over", levels, run: null, end, info };
    return { phase: "idle", levels, run: null, end: null, info: null };
  }

  /**
   * 알바 진행: 시작·판정·지급·업그레이드 구매를 서버가 한 트랜잭션으로 처리한다.
   * 현금이 0원이어도 시작할 수 있고(배팅 없음), 수입은 근무가 끝날 때 현금으로 들어간다.
   */
  private handlePt(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "pt" }>): void {
    const uid = att.userId;
    // 카드 뒤집기는 짧은 간격으로 오므로 간격 검사는 규칙(최소 간격)에 맡기고, 나머지 요청은 속도를 제한한다
    if (msg.act !== "state" && msg.act !== "flip" && this.rateLimited(uid)) {
      ws.send(JSON.stringify({ t: "pt", ok: false, error: "너무 빠릅니다. 잠시 후 다시 시도하세요." } satisfies ServerMsg));
      return;
    }
    let out: ServerMsg | null = null;
    let moneyMoved = false;

    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const st: { run: PtRun | null; end: PtEnd | null; info: PtInfo | null } = { run: this.loadPt(uid), end: null, info: null };
      const finish = (end: PtEnd): void => {
        this.finishPt(uid, end);
        st.run = null;
        st.end = end;
        moneyMoved = moneyMoved || end.pay > 0;
      };
      const view = (): PtView => this.ptView(uid, st.run, st.end, st.info, now);
      const ok = (): void => { out = { t: "pt", ok: true, view: view() }; };
      const err = (error: string): void => { out = { t: "pt", ok: false, error, view: view() }; };
      /** 규칙 함수의 결과를 반영한다 */
      const apply = (s: PtStep): void => {
        if (s.k === "invalid") return err(s.error);
        st.info = s.info ?? null;
        if (s.k === "go") { st.run = s.run; this.savePt(uid, s.run); } else finish(s.end);
        ok();
      };

      // 시간이 지난 근무는 무엇을 요청하든 먼저 그때까지의 수입으로 정산한다
      if (st.run && isPtExpired(st.run, now)) {
        const reason = st.run.job === "memory" ? "fail" : "time";
        const r0: PtRun = st.run.job === "memory" ? { ...st.run, stats: { ...st.run.stats, rounds: st.run.step - 1 } } : st.run;
        finish(ptSettle(r0, now, reason));
      }

      if (msg.act === "state") return ok();

      if (msg.act === "buy") {
        if (st.run) return err("근무 중에는 업그레이드를 살 수 없어요.");
        const def = upgradeDef(String(msg.id));
        if (!def) return err("알 수 없는 업그레이드입니다.");
        const level = levelOf(this.ptLevels(uid), def.id);
        const cost = upgradeCost(def.id, level);
        if (cost === null) return err("이미 최고 레벨입니다.");
        const cash = this.getCash(uid);
        if (cash < cost) return err("잔고가 부족합니다.");
        this.setCash(uid, cash - cost);
        this.sql.exec("INSERT OR REPLACE INTO pt_upgrades (user_id, id, level) VALUES (?, ?, ?)", uid, def.id, level + 1);
        moneyMoved = true;
        return ok();
      }

      if (msg.act === "start") {
        if (st.run) return err("진행 중인 근무가 있습니다.");
        if (!JOB_IDS.includes(msg.job)) return err("알 수 없는 알바입니다.");
        st.end = null;
        st.run = startPtRun(msg.job, this.ptLevels(uid), randomBelow(0x7fffffff), now);
        this.savePt(uid, st.run);
        return ok();
      }

      // 이하는 진행 중인 근무가 있어야 한다. 방금 시간이 다 돼 끝난 경우에는 오류 대신 끝난 결과를 알려 준다.
      if (!st.run) return st.end ? ok() : err("진행 중인 근무가 없습니다.");

      if (msg.act === "end") {
        if (st.run.job === "calc") return err("계산 알바는 답을 제출해야 끝납니다.");
        finish(ptFinishEarly(st.run, now));
        return ok();
      }
      if (msg.act === "submit") return apply(ptSubmitCalc(st.run, msg.answers, now));
      if (msg.act === "mem") return apply(ptSubmitMemory(st.run, msg.input, now));
      if (msg.act === "flip") return apply(ptFlip(st.run, Number(msg.i), now));
      if (msg.act === "pull") return apply(ptPull(st.run, Number(msg.ms), now));
      err("알 수 없는 요청입니다.");
    });

    ws.send(JSON.stringify(out ?? { t: "pt", ok: false, error: "처리하지 못했습니다." }));
    if (moneyMoved) ws.send(JSON.stringify(this.accountMsg(uid)));
  }

  // ── 블록 채우기 퍼즐 ──
  private loadRun(userId: number): Run | null {
    const r = this.sql
      .exec("SELECT bet, cleared, stage, seed, started_at, phase FROM puzzle_runs WHERE user_id = ?", userId)
      .toArray()[0];
    if (!r) return null;
    return {
      bet: Number(r.bet), cleared: Number(r.cleared), stage: Number(r.stage), seed: Number(r.seed),
      startedAt: Number(r.started_at), phase: r.phase === "choice" ? "choice" : "play",
    };
  }

  private saveRun(userId: number, run: Run): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO puzzle_runs (user_id, bet, cleared, stage, seed, started_at, phase) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId, run.bet, run.cleared, run.stage, run.seed, run.startedAt, run.phase,
    );
  }

  /** 판을 끝내고 받을 돈을 계좌에 넣는다. 배팅액은 시작할 때 이미 빠져 있다. (트랜잭션 안에서 호출) */
  private finishRun(userId: number, o: Outcome): void {
    this.sql.exec("DELETE FROM puzzle_runs WHERE user_id = ?", userId);
    if (o.payout > 0) this.setCash(userId, this.getCash(userId) + o.payout);
    this.sql.exec("INSERT INTO puzzle_log (user_id, ts, bet, cleared, payout) VALUES (?, ?, ?, ?, ?)", userId, Date.now(), o.bet, o.cleared, o.payout);
    if (o.payout >= RULES.PUZZLE_FEED_MIN) this.recordTrade(userId, 0, "puzzle", o.payout, 0, 0, o.payout - o.bet, 1);
  }

  private puzzleView(run: Run | null, outcome: Outcome | null, now: number): PuzzleView {
    if (run) {
      return {
        phase: run.phase, bet: run.bet, cleared: run.cleared, stage: run.stage,
        puzzle: run.phase === "play" ? puzzleOf(run) : null,
        remainMs: remainMs(run, now),
        cashValue: payoutFor(run.bet, run.cleared),
        nextValue: payoutFor(run.bet, run.cleared + 1),
        outcome: null,
      };
    }
    if (outcome) {
      return { phase: "over", bet: outcome.bet, cleared: outcome.cleared, stage: outcome.cleared, puzzle: null, remainMs: 0, cashValue: 0, nextValue: 0, outcome };
    }
    return { phase: "idle", bet: 0, cleared: 0, stage: 0, puzzle: null, remainMs: 0, cashValue: 0, nextValue: 0, outcome: null };
  }

  /**
   * 퍼즐 진행: 배팅 차감·퍼즐 생성·시간 판정·정답 검사·정산을 모두 서버가 한 트랜잭션으로 처리한다.
   * 제한 시간은 서버 시각 기준이고, 화면의 타이머는 보여 주기만 한다.
   */
  private handlePuzzle(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "puzzle" }>): void {
    if (msg.act !== "state" && this.rateLimited(att.userId)) {
      ws.send(JSON.stringify({ t: "puzzle", ok: false, error: "너무 빠릅니다. 잠시 후 다시 시도하세요." } satisfies ServerMsg));
      return;
    }
    let out: ServerMsg | null = null;
    let events: LiquidationEvent[] = [];
    let moneyMoved = false;
    let bigWin = 0;
    const uid = att.userId;

    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const st: { run: Run | null; over: Outcome | null } = { run: this.loadRun(uid), over: null };
      const finish = (o: Outcome): void => {
        this.finishRun(uid, o);
        st.run = null;
        st.over = o;
        moneyMoved = true;
        if (o.payout >= RULES.PUZZLE_FEED_MIN) bigWin = o.payout;
      };
      const view = (): PuzzleView => this.puzzleView(st.run, st.over, now);
      const ok = (): void => { out = { t: "puzzle", ok: true, view: view() }; };
      const err = (error: string): void => { out = { t: "puzzle", ok: false, error, view: view() }; };

      // 제한 시간이 지난 판은 무엇을 요청하든 먼저 패배로 정산한다
      if (st.run && isExpired(st.run, now)) finish(lose(st.run));

      if (msg.act === "state") return ok();

      if (msg.act === "start") {
        if (st.run) return err("진행 중인 판이 있습니다.");
        const bad = checkBet(msg.bet);
        if (bad) return err(bad);
        events = this.liquidateUser(uid);
        const cash = this.getCash(uid);
        if (msg.bet > cash) return err("잔고가 부족합니다.");
        this.setCash(uid, cash - msg.bet);
        st.over = null;
        st.run = newRun(msg.bet, randomBelow(0x7fffffff), now);
        this.saveRun(uid, st.run);
        moneyMoved = true;
        return ok();
      }

      // 이번 요청 직전에 시간 초과로 끝난 판이면 오류가 아니라 "끝났다"는 결과(over)를 그대로 알려 준다
      if (!st.run) return st.over ? ok() : err("진행 중인 판이 없습니다.");

      if (msg.act === "submit") {
        const r = submitPuzzle(st.run, Array.isArray(msg.placements) ? msg.placements : [], now);
        if (r.k === "invalid") return err(r.error);
        if (r.k === "expired" || r.k === "max") finish(r.outcome);
        else { st.run = r.run; this.saveRun(uid, st.run); }
        return ok();
      }

      if (msg.act === "next") {
        const n = nextStage(st.run, randomBelow(0x7fffffff), now);
        if (!n) return err("지금은 다음 단계로 갈 수 없습니다.");
        st.run = n;
        this.saveRun(uid, n);
        return ok();
      }

      if (msg.act === "cash") {
        const o = cashOut(st.run);
        if (!o) return err("지금은 정산할 수 없습니다.");
        finish(o);
        return ok();
      }
      err("알 수 없는 요청입니다.");
    });

    this.notifyLiquidations(events);
    ws.send(JSON.stringify(out ?? { t: "puzzle", ok: false, error: "처리하지 못했습니다." }));
    if (moneyMoved) ws.send(JSON.stringify(this.accountMsg(uid)));
    if (bigWin > 0) {
      this.broadcast({ t: "fill", item: { ts: Date.now(), nick: att.nickname, stock: 0, action: "puzzle", qty: bigWin, price: 0 } });
    }
  }

  /** 프레스티지: 순자산이 기준 이상일 때만. 포지션을 모두 지우고 별 +1, 현금은 새 시작 자금으로 초기화. */
  private handlePrestige(ws: WebSocket, att: Attachment): void {
    let out: ServerMsg = { t: "prestige", ok: false, error: "처리하지 못했습니다." };
    let events: LiquidationEvent[] = [];
    let done: { stars: number; nw: number } | null = null;
    this.ctx.storage.transactionSync(() => {
      events = this.liquidateUser(att.userId);
      const cash = this.getCash(att.userId);
      const nw = netWorth(cash, this.getPositions(att.userId), (s) => this.priceNow(s));
      if (nw < RULES.PRESTIGE_NET_WORTH) {
        out = { t: "prestige", ok: false, error: "순자산이 10억 원 이상이어야 합니다." };
        return;
      }
      const stars = Number(this.sql.exec("SELECT stars FROM accounts WHERE user_id = ?", att.userId).one().stars) + 1;
      const newCash = startCapital(stars);
      this.sql.exec("DELETE FROM positions WHERE user_id = ?", att.userId);
      this.sql.exec("UPDATE accounts SET cash = ?, stars = ? WHERE user_id = ?", newCash, stars, att.userId);
      this.recordTrade(att.userId, 0, "prestige", stars, nw, 0, null, 1);
      out = { t: "prestige", ok: true, stars, cash: newCash };
      done = { stars, nw };
    });
    this.notifyLiquidations(events);
    ws.send(JSON.stringify(out));
    ws.send(JSON.stringify(this.accountMsg(att.userId)));
    if (done) {
      const d: { stars: number; nw: number } = done;
      this.broadcast({ t: "fill", item: { ts: Date.now(), nick: att.nickname, stock: 0, action: "prestige", qty: d.stars, price: d.nw } });
    }
  }

  // ── 계좌 · 거래 ──
  private seedCache: number | null = null;
  private epochCache: number | null = null;
  private priceCache = new Map<number, PriceState>();
  private orderTimes = new Map<number, number[]>(); // 유저별 최근 주문 시각 (속도 제한)

  private currentTick(): number {
    this.epochCache ??= Number(this.meta("epoch"));
    return tickAt(Date.now(), this.epochCache, RULES.TICK_MS);
  }

  /** 서버 현재 tick 기준 가격. 체크포인트에서 이어 계산하고 메모리에 캐시한다. */
  private priceNow(stockId: number): number {
    const def = getStock(stockId);
    if (def.kind === "etf") return etfPrice(def, (id) => this.priceNow(id)); // 구성 종목의 현재가에서 계산
    this.seedCache ??= Number(this.meta("seed"));
    const cur = this.currentTick();
    let st = this.priceCache.get(stockId);
    if (!st) {
      const row = this.sql.exec("SELECT tick, price FROM checkpoints WHERE stock_id = ?", stockId).one();
      st = { tick: Number(row.tick), price: Number(row.price) };
    }
    if (cur > st.tick) st = advance(getStock(stockId), this.seedCache, st, cur, this.effects(stockId));
    this.priceCache.set(stockId, st);
    return st.price;
  }

  private ensureAccount(userId: number): void {
    this.sql.exec("INSERT OR IGNORE INTO accounts (user_id, cash) VALUES (?, ?)", userId, RULES.START_CASH);
  }

  private getCash(userId: number): number {
    this.ensureAccount(userId);
    return Number(this.sql.exec("SELECT cash FROM accounts WHERE user_id = ?", userId).one().cash);
  }

  private setCash(userId: number, cash: number): void {
    this.sql.exec("UPDATE accounts SET cash = ? WHERE user_id = ?", cash, userId);
  }

  private toPosition(r: Record<string, SqlStorageValue>): Position {
    return {
      stock: Number(r.stock_id),
      side: r.side === "short" ? "short" : "long",
      qty: Number(r.qty),
      cost: Number(r.cost),
      margin: Number(r.margin),
      leverage: Number(r.leverage),
    };
  }

  private getPositions(userId: number): Position[] {
    return this.sql
      .exec("SELECT stock_id, side, qty, cost, margin, leverage FROM positions WHERE user_id = ? ORDER BY stock_id", userId)
      .toArray()
      .map((r) => this.toPosition(r));
  }

  private today(): number {
    return Math.floor((Date.now() + KST_MS) / 86_400_000);
  }

  private accountMsg(userId: number): ServerMsg {
    this.ensureAccount(userId);
    const a = this.sql
      .exec("SELECT cash, bailout_day, bailout_count, stars, lottery_day, lottery_count FROM accounts WHERE user_id = ?", userId)
      .one();
    const used = Number(a.bailout_day) === this.today() ? Number(a.bailout_count) : 0;
    const lotteryUsed = Number(a.lottery_day) === this.today() ? Number(a.lottery_count) : 0;
    const positions: PositionInfo[] = this.getPositions(userId).map((p) => ({ ...p, liqPrice: liquidationPrice(p) }));
    return {
      t: "account",
      cash: Number(a.cash),
      positions,
      bailoutLeft: Math.max(0, RULES.BAILOUT_PER_DAY - used),
      stars: Number(a.stars),
      lotteryLeft: Math.max(0, RULES.LOTTERY_PER_DAY - lotteryUsed),
    };
  }

  private addVolume(stockId: number, tick: number, qty: number): void {
    this.epochCache ??= Number(this.meta("epoch"));
    const t = bucketTime(tick, this.epochCache, RULES.TICK_MS, INTERVALS["1m"]);
    this.sql.exec(
      "INSERT INTO vol1m (stock_id, t, v) VALUES (?, ?, ?) ON CONFLICT (stock_id, t) DO UPDATE SET v = v + excluded.v",
      stockId, t, qty,
    );
  }

  /** 오늘(한국 시간 0시~)의 시가·고가·저가·거래량. 저장된 일봉(체크포인트까지)에 최근 구간을 서버가 이어 계산해 현재 tick까지 맞춘다. */
  private dayInits(): DayInit[] {
    this.epochCache ??= Number(this.meta("epoch"));
    const epoch = this.epochCache;
    const cur = this.currentTick();
    const day = bucketTime(cur, epoch, RULES.TICK_MS, INTERVALS["1d"]);
    const out: DayInit[] = [];
    for (const cp of this.latestCheckpoints()) {
      const row = this.sql
        .exec("SELECT o, h, l FROM candles WHERE stock_id = ? AND iv = '1d' AND t = ?", cp.stock, day)
        .toArray()[0];
      let open = row ? Number(row.o) : undefined;
      let high = row ? Number(row.h) : undefined;
      let low = row ? Number(row.l) : undefined;
      let last = cp.price;
      const tail = this.pathSince(cp.stock, cp, cur);
      tail.forEach((price, i) => {
        last = price;
        if (bucketTime(cp.tick + 1 + i, epoch, RULES.TICK_MS, INTERVALS["1d"]) !== day) return; // 자정 이전 구간
        if (open === undefined) { open = price; high = price; low = price; }
        else { high = Math.max(high!, price); low = Math.min(low!, price); }
      });
      const vol = this.sql.exec("SELECT COALESCE(SUM(v), 0) AS v FROM vol1m WHERE stock_id = ? AND t >= ?", cp.stock, day).one();
      out.push({
        stock: cp.stock,
        day,
        open: open ?? last,
        high: high ?? last,
        low: low ?? last,
        volume: Number(vol.v),
      });
    }
    return out;
  }

  private recentFeed(): FeedItem[] {
    return this.sql
      .exec(
        `SELECT t.ts, u.nickname, t.stock_id, t.action, t.qty, t.price FROM trades t
         JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 30`,
      )
      .toArray()
      .map((r) => ({
        ts: Number(r.ts), nick: String(r.nickname), stock: Number(r.stock_id),
        action: r.action as FeedItem["action"], qty: Number(r.qty), price: Number(r.price),
      }));
  }

  private broadcast(msg: ServerMsg): void {
    const s = JSON.stringify(msg);
    for (const w of this.openSockets()) w.send(s);
  }

  private recordTrade(userId: number, stock: number, action: string, qty: number, price: number, fee: number, pnl: number | null, leverage: number): void {
    this.sql.exec(
      "INSERT INTO trades (user_id, ts, stock_id, action, qty, price, fee, pnl, leverage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      userId, Date.now(), stock, action, qty, price, fee, pnl, leverage,
    );
  }

  /** 포지션을 주어진 가격으로 강제 청산하고 기록한다. (트랜잭션 안에서 호출) */
  private settleLiquidation(userId: number, pos: Position, price: number, tick: number): LiquidationEvent {
    const r = liquidate(this.getCash(userId), pos, price);
    this.setCash(userId, r.cash);
    this.sql.exec("DELETE FROM positions WHERE user_id = ? AND stock_id = ? AND side = ?", userId, pos.stock, pos.side);
    this.recordTrade(userId, pos.stock, "liquidation", pos.qty, price, r.fee, r.pnl, pos.leverage);
    this.addVolume(pos.stock, tick, pos.qty);
    return { userId, stock: pos.stock, side: pos.side, qty: pos.qty, price, returned: r.returned };
  }

  /** 체크포인트마다: 직전 구간의 모든 tick을 훑어 청산 조건에 처음 걸린 tick의 가격으로 정산한다. */
  private scanLiquidations(paths: Map<number, { from: number; prices: number[] }>, events: LiquidationEvent[]): void {
    const rows = this.sql
      .exec("SELECT user_id, stock_id, side, qty, cost, margin, leverage, opened_tick FROM positions")
      .toArray();
    for (const r of rows) {
      const path = paths.get(Number(r.stock_id));
      if (!path) continue;
      const pos = this.toPosition(r);
      const hit = firstLiquidation(pos, path.prices, path.from, Number(r.opened_tick));
      if (hit) events.push(this.settleLiquidation(Number(r.user_id), pos, hit.price, hit.tick));
    }
  }

  /** 주문·조회 시점: 이 유저의 포지션을 현재가로 검사한다. (트랜잭션 안에서 호출) */
  private liquidateUser(userId: number): LiquidationEvent[] {
    const out: LiquidationEvent[] = [];
    for (const pos of this.getPositions(userId)) {
      const price = this.priceNow(pos.stock);
      if (isLiquidatable(pos, price)) out.push(this.settleLiquidation(userId, pos, price, this.currentTick()));
    }
    return out;
  }

  private liquidateInTx(userId: number): LiquidationEvent[] {
    let ev: LiquidationEvent[] = [];
    this.ctx.storage.transactionSync(() => {
      ev = this.liquidateUser(userId);
    });
    return ev;
  }

  private socketsOf(userId: number): WebSocket[] {
    return this.openSockets().filter((w) => (w.deserializeAttachment() as Attachment | null)?.userId === userId);
  }

  private notifyLiquidations(events: LiquidationEvent[]): void {
    const users = new Set<number>();
    for (const e of events) {
      users.add(e.userId);
      const nick = this.sql.exec("SELECT nickname FROM users WHERE id = ?", e.userId).toArray()[0]?.nickname;
      this.broadcast({
        t: "fill",
        item: { ts: Date.now(), nick: String(nick ?? "?"), stock: e.stock, action: "liquidation", qty: e.qty, price: e.price },
      });
      const msg = JSON.stringify({ t: "liquidated", stock: e.stock, side: e.side, qty: e.qty, price: e.price, returned: e.returned } satisfies ServerMsg);
      for (const w of this.socketsOf(e.userId)) w.send(msg);
    }
    for (const id of users) {
      const msg = JSON.stringify(this.accountMsg(id));
      for (const w of this.socketsOf(id)) w.send(msg);
    }
  }

  private rateLimited(userId: number): boolean {
    const now = Date.now();
    const arr = (this.orderTimes.get(userId) ?? []).filter((x) => now - x < 1000);
    if (arr.length >= RULES.ORDERS_PER_SEC) {
      this.orderTimes.set(userId, arr);
      return true;
    }
    arr.push(now);
    this.orderTimes.set(userId, arr);
    return false;
  }

  /**
   * 주문 한 건을 계산하고 반영한다. 트랜잭션 안에서 호출해야 한다.
   * 실패하면 아무것도 쓰지 않고 error를 돌려준다. 시장가 주문과 예약 주문이 같이 쓴다.
   */
  private applyOrder(
    userId: number, stockId: number, action: OrderAction, qty: number, leverage: number, price: number, tick: number,
  ): { ok: true; fill: Omit<Fill, "slipped"> } | { ok: false; error: string } {
    const cash = this.getCash(userId);
    const side = action === "buy" || action === "sell" ? "long" : "short";
    const other = side === "long" ? "short" : "long";
    const row = (s: string) =>
      this.sql
        .exec("SELECT stock_id, side, qty, cost, margin, leverage FROM positions WHERE user_id = ? AND stock_id = ? AND side = ?", userId, stockId, s)
        .toArray()[0];
    const posRow = row(side);
    const pos = posRow ? this.toPosition(posRow) : undefined;

    const opening = action === "buy" || action === "short";
    if (opening && row(other)) {
      return { ok: false, error: side === "long" ? "이 종목의 공매도 포지션을 먼저 정리하세요." : "이 종목의 보유 수량을 먼저 매도하세요." };
    }
    let r: OrderResult;
    if (action === "buy") r = buy(cash, pos, stockId, qty, price, leverage);
    else if (action === "sell") r = sell(cash, pos, qty, price);
    else if (action === "short") r = short(cash, pos, stockId, qty, price, leverage);
    else r = cover(cash, pos, qty, price);
    if (!r.ok) return { ok: false, error: r.error };

    this.setCash(userId, r.cash);
    if (r.position === null) {
      this.sql.exec("DELETE FROM positions WHERE user_id = ? AND stock_id = ? AND side = ?", userId, stockId, side);
    } else if (opening) {
      this.sql.exec(
        `INSERT INTO positions (user_id, stock_id, side, qty, cost, margin, leverage, opened_tick) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, stock_id, side) DO UPDATE SET
           qty = excluded.qty, cost = excluded.cost, margin = excluded.margin, leverage = excluded.leverage, opened_tick = excluded.opened_tick`,
        userId, stockId, side, r.position.qty, r.position.cost, r.position.margin, r.position.leverage, tick,
      );
    } else {
      this.sql.exec(
        "UPDATE positions SET qty = ?, cost = ?, margin = ? WHERE user_id = ? AND stock_id = ? AND side = ?",
        r.position.qty, r.position.cost, r.position.margin, userId, stockId, side,
      );
    }
    this.addVolume(stockId, tick, r.qty);
    const lev = r.position?.leverage ?? pos?.leverage ?? 1;
    this.recordTrade(userId, stockId, action, r.qty, price, r.fee, r.pnl, lev);
    return { ok: true, fill: { stock: stockId, action, qty: r.qty, price, fee: r.fee, pnl: r.pnl } };
  }

  private handleOrder(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: "order" }>): void {
    const id = Number(msg.id) || 0;
    const reject = (error: string) => ws.send(JSON.stringify({ t: "order", id, ok: false, error } satisfies ServerMsg));
    if (this.rateLimited(att.userId)) return reject("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    const stock = STOCKS.find((s) => s.id === msg.stock);
    if (!stock) return reject("없는 종목입니다.");
    const action = msg.action as OrderAction;
    if (!["buy", "sell", "short", "cover"].includes(action)) return reject("알 수 없는 주문입니다.");

    // 이 블록 안에는 await가 없다 → Market은 한 번에 한 주문만 처리하므로 잔고가 어긋나지 않는다.
    let fill: Fill | null = null;
    let error: string | null = null;
    let events: LiquidationEvent[] = [];
    this.ctx.storage.transactionSync(() => {
      events = this.liquidateUser(att.userId);
      const price = this.priceNow(stock.id);
      const r = this.applyOrder(att.userId, stock.id, action, msg.qty, Number(msg.leverage ?? 1), price, this.currentTick());
      if (!r.ok) {
        error = r.error;
        return;
      }
      fill = { ...r.fill, slipped: typeof msg.px === "number" && msg.px !== price };
    });

    this.notifyLiquidations(events);
    if (error || !fill) return reject(error ?? "주문을 처리하지 못했습니다.");
    const done: Fill = fill;
    ws.send(JSON.stringify({ t: "order", id, ok: true, fill: done } satisfies ServerMsg));
    this.broadcast({
      t: "fill",
      item: { ts: Date.now(), nick: att.nickname, stock: done.stock, action: done.action, qty: done.qty, price: done.price },
    });
    ws.send(JSON.stringify(this.accountMsg(att.userId)));
  }

  private handleBailout(ws: WebSocket, att: Attachment): void {
    let result: ServerMsg = { t: "bailout", ok: false, error: "처리하지 못했습니다." };
    let events: LiquidationEvent[] = [];
    this.ctx.storage.transactionSync(() => {
      events = this.liquidateUser(att.userId);
      const cash = this.getCash(att.userId);
      const nw = netWorth(cash, this.getPositions(att.userId), (s) => this.priceNow(s));
      if (nw > 0) {
        result = { t: "bailout", ok: false, error: "순자산이 0 이하일 때만 신청할 수 있습니다." };
        return;
      }
      const a = this.sql.exec("SELECT bailout_day, bailout_count FROM accounts WHERE user_id = ?", att.userId).one();
      const today = this.today();
      const used = Number(a.bailout_day) === today ? Number(a.bailout_count) : 0;
      if (used >= RULES.BAILOUT_PER_DAY) {
        result = { t: "bailout", ok: false, error: "오늘은 이미 구제를 받았습니다." };
        return;
      }
      this.sql.exec(
        "UPDATE accounts SET cash = cash + ?, bailout_day = ?, bailout_count = ? WHERE user_id = ?",
        RULES.BAILOUT_AMOUNT, today, used + 1, att.userId,
      );
      result = { t: "bailout", ok: true, amount: RULES.BAILOUT_AMOUNT };
    });
    this.notifyLiquidations(events);
    ws.send(JSON.stringify(result));
    ws.send(JSON.stringify(this.accountMsg(att.userId)));
  }

  private sendTrades(ws: WebSocket, userId: number): void {
    const trades: TradeRecord[] = this.sql
      .exec("SELECT ts, stock_id, action, qty, price, fee, pnl, leverage FROM trades WHERE user_id = ? ORDER BY id DESC LIMIT 100", userId)
      .toArray()
      .map((r) => ({
        ts: Number(r.ts),
        stock: Number(r.stock_id),
        action: r.action as TradeRecord["action"],
        qty: Number(r.qty),
        price: Number(r.price),
        fee: Number(r.fee),
        pnl: r.pnl === null ? null : Number(r.pnl),
        leverage: Number(r.leverage),
      }));
    ws.send(JSON.stringify({ t: "trades", trades } satisfies ServerMsg));
  }

  // ── WebSocket (Hibernation API) ──
  private async handleWs(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return fail(426, "WebSocket 요청이 필요합니다.");
    // 다른 사이트에서 쿠키를 실어 연결하는 것을 막는다
    const origin = req.headers.get("Origin");
    if (origin && new URL(origin).host !== new URL(req.url).host) return fail(403, "허용되지 않은 출처입니다.");

    const u = await this.userFromRequest(req);
    if (!u || u.banned) return fail(401, "로그인이 필요합니다.");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att: Attachment = { userId: u.id, nickname: u.nickname, role: u.role, v: Number(new URL(req.url).searchParams.get("v")) || 0 };
    server.serializeAttachment(att);

    const newsUntil = this.newsUntil(u.id);
    const hello: ServerMsg = {
      t: "hello",
      viewSeed: this.viewSeed(),
      epoch: Number(this.meta("epoch")),
      tickMs: RULES.TICK_MS,
      serverNow: Date.now(),
      online: this.onlineCount(),
      user: { id: u.id, nickname: u.nickname, role: u.role },
      px: { ...this.currentPx(), ids: STOCKS.map((s) => s.id) },
      days: this.dayInits(),
      news: newsUntil > Date.now() ? this.recentNews() : [],
      appVersion: APP_VERSION,
      newsUntil,
      maintenance: this.maintenanceInfo(),
      minVersion: this.minVersion(),
    };
    server.send(JSON.stringify(hello));
    server.send(JSON.stringify(this.accountMsg(u.id)));
    server.send(JSON.stringify({ t: "feed", items: this.recentFeed() } satisfies ServerMsg));
    this.broadcastOnline();
    this.startTicker();
    return new Response(null, { status: 101, webSocket: client });
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }

  /** 접속자 수 = 서로 다른 로그인 유저 수 */
  private onlineCount(): number {
    const ids = new Set<number>();
    for (const w of this.openSockets()) {
      const a = w.deserializeAttachment() as Attachment | null;
      if (a) ids.add(a.userId);
    }
    return ids.size;
  }

  private broadcastOnline(): void {
    const msg = JSON.stringify({ t: "online", n: this.onlineCount() } satisfies ServerMsg);
    for (const w of this.openSockets()) w.send(msg);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    this.bumpStat("wsm");
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "ping" && typeof msg.c === "number") {
      ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() } satisfies ServerMsg));
    } else if (msg.t === "candles") {
      this.sendCandles(ws, msg);
    } else {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) return;
      const blocked =
        msg.t === "order" || msg.t === "bailout" || msg.t === "lottery" || msg.t === "prestige" || msg.t === "reserve" || msg.t === "claim" || msg.t === "puzzle" || msg.t === "pt" || msg.t === "newsPass"
          ? this.gate(att)
          : null;
      if (blocked) {
        const id = msg.t === "order" ? Number(msg.id) || 0 : 0;
        const reply =
          msg.t === "order" ? { t: "order", id, ok: false, error: blocked }
          : msg.t === "lottery" ? { t: "lottery", ok: false, error: blocked }
          : { t: msg.t, ok: false, error: blocked };
        ws.send(JSON.stringify(reply));
        return;
      }
      // 처리 중 예외가 나도 클라이언트가 응답을 기다리며 멈추지 않도록, 응답이 필요한 메시지에는 실패 응답을 보낸다.
      try {
        if (msg.t === "order") this.handleOrder(ws, att, msg);
        else if (msg.t === "account") {
          this.notifyLiquidations(this.liquidateInTx(att.userId));
          ws.send(JSON.stringify(this.accountMsg(att.userId)));
        } else if (msg.t === "trades") this.sendTrades(ws, att.userId);
        else if (msg.t === "bailout") this.handleBailout(ws, att);
        else if (msg.t === "lb") this.handleLb(ws, att, msg);
        else if (msg.t === "hof") this.handleHof(ws);
        else if (msg.t === "lottery") this.handleLottery(ws, att, msg);
        else if (msg.t === "puzzle") this.handlePuzzle(ws, att, msg);
        else if (msg.t === "pt") this.handlePt(ws, att, msg);
        else if (msg.t === "prestige") this.handlePrestige(ws, att);
        else if (msg.t === "newsPass") this.handleNewsPass(ws, att);
        else if (msg.t === "stats") this.handleStats(ws, att);
        else if (msg.t === "quests") this.handleQuests(ws, att);
        else if (msg.t === "claim") this.handleClaim(ws, att, msg);
        else if (msg.t === "reserves") this.sendReserves(ws, att.userId);
        else if (msg.t === "reserve") this.handleReserve(ws, att, msg);
        else if (msg.t === "cancelReserve") this.handleCancelReserve(ws, att, msg);
      } catch (e) {
        console.error("message handler failed", msg.t, e);
        const error = "서버에서 처리하지 못했습니다. 잠시 후 다시 시도하세요.";
        try {
          if (msg.t === "order") ws.send(JSON.stringify({ t: "order", id: Number(msg.id) || 0, ok: false, error } satisfies ServerMsg));
          else if (msg.t === "lottery") ws.send(JSON.stringify({ t: "lottery", ok: false, error } satisfies ServerMsg));
          else if (msg.t === "bailout" || msg.t === "prestige" || msg.t === "reserve" || msg.t === "claim" || msg.t === "puzzle" || msg.t === "pt" || msg.t === "newsPass") ws.send(JSON.stringify({ t: msg.t, ok: false, error } satisfies ServerMsg));
        } catch { /* 소켓이 이미 닫힘 */ }
      }
    }
  }

  private sendCandles(ws: WebSocket, msg: Extract<ClientMsg, { t: "candles" }>): void {
    if (!STOCKS.some((s) => s.id === msg.stock) || !(msg.iv in INTERVALS)) return;
    const limit = Math.min(Math.max(Math.floor(Number(msg.limit) || 500), 1), 1000);
    const rows = this.sql
      .exec(
        "SELECT t, o, h, l, c, v FROM candles WHERE stock_id = ? AND iv = ? ORDER BY t DESC LIMIT ?",
        msg.stock,
        msg.iv,
        limit,
      )
      .toArray();
    const candles: Candle[] = rows
      .reverse()
      .map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
    const cp = this.latestCheckpoints().find((c) => c.stock === msg.stock);
    if (!cp) return;
    // 저장된 봉은 체크포인트까지이므로, 그 뒤 현재 tick까지는 서버가 계산해 이어 붙인다 (클라이언트는 가격을 계산하지 않는다)
    this.epochCache ??= Number(this.meta("epoch"));
    const cur = this.currentTick();
    this.pathSince(msg.stock, cp, cur).forEach((price, i) => {
      const t = cp.tick + 1 + i;
      applyPrice(candles, bucketTime(t, this.epochCache!, RULES.TICK_MS, INTERVALS[msg.iv]), price);
    });
    const ivSec = INTERVALS[msg.iv] / 1000;
    const vols = this.sql
      .exec(
        `SELECT CAST(t / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER) AS b, SUM(v) AS v
         FROM vol1m WHERE stock_id = ? AND t >= ? GROUP BY b`,
        ivSec, ivSec, msg.stock, candles[0]?.t ?? 0,
      )
      .toArray()
      .map((r): [number, number] => [Number(r.b), Number(r.v)]);
    ws.send(JSON.stringify({ t: "candles", stock: msg.stock, iv: msg.iv, candles, tick: Math.max(cp.tick, cur), vols } satisfies ServerMsg));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      /* 이미 닫힘 */
    }
    this.broadcastOnline();
    this.maybeStopTicker();
  }

  async webSocketError(): Promise<void> {
    this.broadcastOnline();
    this.maybeStopTicker();
  }
}
