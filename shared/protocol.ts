// WebSocket 메시지 타입 (프론트와 서버 공용)

import type { Candle, IntervalKey } from "./candles";
import type { Position } from "./trading";
import type { Metric, Period } from "./leaderboard";
import type { AchievementView, MissionView, MyStats } from "./records";
import type { ReserveCond, ReserveItem } from "./reserve";
import type { Placement, Puzzle } from "./puzzle";
import type { Outcome } from "./puzzlerun";
import type { JobId } from "./parttime";
import type { PtEnd, PtInfo, PtViewData } from "./ptrun";

export interface Checkpoint {
  stock: number;
  tick: number;
  price: number;
}

export type OrderAction = "buy" | "sell" | "short" | "cover";

export interface PositionInfo extends Position {
  liqPrice: number | null;
}

export interface Fill {
  stock: number;
  action: OrderAction;
  qty: number;
  price: number; // 서버가 정한 체결가
  fee: number;
  pnl: number | null; // 매도·환매일 때 실현손익(수수료 포함)
  slipped: boolean; // 화면 가격과 체결가가 달랐음 ("가격 변동됨" 안내용)
}

export interface TradeRecord {
  ts: number;
  stock: number;
  action: OrderAction | "liquidation" | "prestige" | "lottery" | "puzzle";
  qty: number;
  price: number;
  fee: number;
  pnl: number | null;
  leverage: number;
}

/** 오늘(한국 시간 0시~) 통계의 시작점. 이후는 클라이언트가 엔진으로 이어 계산한다. */
export interface DayInit {
  stock: number;
  day: number; // 오늘 1일봉 시작 시각(초, KST 이동값)
  open: number;
  high: number;
  low: number;
  volume: number;
}

/** 전체 유저에게 보이는 체결 피드 항목 */
export interface FeedItem {
  ts: number;
  nick: string;
  stock: number; // 프레스티지·복권은 0
  action: OrderAction | "liquidation" | "prestige" | "lottery" | "puzzle"; // prestige: qty=새 별 수 / lottery·puzzle: qty=받은 금액
  qty: number;
  price: number;
}

export interface NewsItem {
  id: number;
  ts: number; // 적용 시작 시각(ms)
  stock: number;
  headline: string;
}

export interface MaintenanceInfo {
  on: boolean;
  message: string;
}

export interface LbEntry {
  rank: number;
  nick: string;
  value: number; // 지표 값 (순자산/증감액 원, 수익률 비율, 명예 점수 원값)
  stars: number;
  prev: number | null; // 이전 순위 (10분 이상 지난 스냅샷). 없으면 신규
  me: boolean;
}

export interface HofRow {
  rank: number;
  nick: string;
  value: number;
  stars: number;
}

export interface HofGroup {
  label: string;
  endedAt: number;
  top: Record<Metric, HofRow[]>;
}

/** 블록 채우기 판의 현재 모습. 정답 정보는 들어 있지 않다. */
export interface PuzzleView {
  phase: "idle" | "play" | "choice" | "over";
  bet: number;
  cleared: number;
  stage: number;
  puzzle: Puzzle | null; // play일 때만
  remainMs: number; // play일 때 표시용 남은 시간 (네트워크 여유 제외)
  cashValue: number; // 지금 정산하면 받는 금액 (choice)
  nextValue: number; // 다음 단계를 깨면 정산할 수 있는 금액 (choice)
  outcome: Outcome | null; // over일 때
}

/** 알바 화면이 그릴 현재 모습. 계산 정답이나 카드 뒷면 같은 비밀은 들어 있지 않다. */
export interface PtView {
  phase: "idle" | "play" | "over";
  levels: Record<string, number>; // 업그레이드 레벨
  run: PtViewData | null; // play일 때만
  end: PtEnd | null; // over일 때만
  info: PtInfo | null; // 이번 요청의 부가 결과 (튀김 등급, 카드 내용 등)
}

export interface UserInfo {
  id: number;
  nickname: string;
  role: "user" | "admin";
}

/** 클라이언트 -> 서버 */
export type ClientMsg =
  | { t: "ping"; c: number } // c: 클라이언트 시각(ms), pong에 그대로 돌아온다
  | { t: "candles"; stock: number; iv: IntervalKey; limit?: number }
  | {
      t: "order";
      id: number; // 클라이언트가 붙이는 번호. 응답에 그대로 돌아온다
      stock: number;
      action: OrderAction;
      qty: number;
      leverage?: number; // 매수·공매도일 때만
      px?: number; // 화면에 보이던 가격 (참고용. 체결은 항상 서버 가격)
    }
  | { t: "account" }
  | { t: "lb"; period: Period; metric: Metric }
  | { t: "hof" }
  | { t: "lottery"; count: number }
  | { t: "pt"; act: "state" | "end" }
  | { t: "pt"; act: "start"; job: JobId }
  | { t: "pt"; act: "submit"; answers: (number | null)[] }
  | { t: "pt"; act: "mem"; input: number[] }
  | { t: "pt"; act: "flip"; i: number }
  | { t: "pt"; act: "pull"; ms: number }
  | { t: "pt"; act: "buy"; id: string }
  | { t: "puzzle"; act: "state" | "next" | "cash" }
  | { t: "puzzle"; act: "start"; bet: number }
  | { t: "puzzle"; act: "submit"; placements: Placement[] }
  | { t: "prestige" }
  | { t: "trades" }
  | { t: "bailout" }
  | { t: "stats" } // 내 성적표
  | { t: "quests" } // 오늘의 미션 · 업적
  | { t: "claim"; id: string } // 미션 보상 받기
  | { t: "reserves" } // 내 예약 주문 목록
  | { t: "reserve"; stock: number; action: OrderAction; qty: number; leverage?: number; cond: ReserveCond; trigger: number }
  | { t: "cancelReserve"; id: number }
  | { t: "newsPass" }; // 뉴스 열람권 구매

/** 서버 -> 클라이언트 */
export type ServerMsg =
  | {
      t: "hello";
      viewSeed: number; // 호가창 잔량 같은 표시용 값에만 쓰는 시드. 가격과 무관하다
      epoch: number;
      tickMs: number;
      serverNow: number;
      online: number;
      user: UserInfo;
      px: { tick: number; p: number[]; ids?: number[] }; // 현재 tick의 종목별 가격. ids는 p의 각 값이 어느 종목인지 (이후 px 메시지도 같은 순서)
      days: DayInit[]; // 종목별 오늘 시가·고가·저가·거래량 (현재 tick까지)
      news: NewsItem[]; // 최근에 시작된 뉴스 (열람권이 없으면 빈 배열)
      appVersion: string; // 서버의 앱 버전. 화면의 버전과 다르면 새로 배포된 것이므로 화면이 스스로 새로고침한다
      newsUntil: number; // 뉴스 열람권 만료 시각(ms). 지금보다 이르면 열람권 없음
      maintenance: MaintenanceInfo;
      minVersion: number;
    }
  | {
      t: "candles";
      stock: number;
      iv: IntervalKey;
      candles: Candle[]; // 현재 tick까지의 봉 (오래된 순)
      tick: number; // 마지막으로 반영된 tick
      vols: [number, number][]; // [봉 시작 시각, 거래량] — 현재 진행 중인 봉까지 포함
    }
  | { t: "order"; id: number; ok: true; fill: Fill }
  | { t: "order"; id: number; ok: false; error: string }
  | { t: "account"; cash: number; positions: PositionInfo[]; bailoutLeft: number; stars: number; lotteryLeft: number }
  | { t: "lottery"; ok: true; payouts: number[]; cost: number; payout: number; left: number }
  | { t: "lottery"; ok: false; error: string }
  | { t: "pt"; ok: true; view: PtView }
  | { t: "pt"; ok: false; error: string; view?: PtView }
  | { t: "puzzle"; ok: true; view: PuzzleView }
  | { t: "puzzle"; ok: false; error: string; view?: PuzzleView } // view가 있으면 판은 그대로 이어진다
  | { t: "prestige"; ok: boolean; error?: string; stars?: number; cash?: number }
  | { t: "liquidated"; stock: number; side: "long" | "short"; qty: number; price: number; returned: number }
  | { t: "trades"; trades: TradeRecord[] }
  | { t: "bailout"; ok: boolean; error?: string; amount?: number }
  | { t: "stats"; stats: MyStats }
  | { t: "quests"; day: number; missions: MissionView[]; achievements: AchievementView[] }
  | { t: "claim"; ok: boolean; id?: string; error?: string; amount?: number }
  | { t: "reserves"; items: ReserveItem[] } // 대기 중 + 최근 끝난 예약
  | { t: "reserve"; ok: true; item: ReserveItem }
  | { t: "reserve"; ok: false; error: string }
  | { t: "cancelReserve"; ok: boolean; id: number; error?: string }
  | { t: "reserveDone"; item: ReserveItem } // 예약이 체결·실패·만료되었을 때 서버가 알림
  | {
      t: "lb";
      period: Period;
      metric: Metric;
      at: number; // 집계 시각 (0이면 아직 없음)
      total: number; // 순위에 오른 전체 인원
      entries: LbEntry[]; // 상위 100위
      me: LbEntry | null; // 내 순위 (순위권 밖이어도 표시)
      season: { name: string; startedAt: number } | null; // 진행 중인 시즌
    }
  | { t: "hof"; seasons: HofGroup[]; weeks: HofGroup[] }
  | { t: "px"; tick: number; p: number[] } // 매 tick 전송: 종목별 현재가 (STOCKS 순서)
  | { t: "news"; item: NewsItem } // 이벤트가 적용되는 시점에 전송 (열람권이 있는 접속자에게만)
  | { t: "newsPass"; ok: true; until: number; cost: number; news: NewsItem[] }
  | { t: "newsPass"; ok: false; error: string }
  | { t: "maintenance"; on: boolean; message: string }
  | { t: "lbTick" } // 순위가 새로 계산됨 → 보고 있다면 다시 요청
  | { t: "feed"; items: FeedItem[] } // 접속 직후: 최근 체결 (최신순)
  | { t: "fill"; item: FeedItem } // 실시간 체결 한 건
  | { t: "pong"; c: number; s: number } // s: 서버 시각(ms)
  | { t: "online"; n: number }
  | { t: "error"; message: string };
