// 화면 전체가 공유하는 상태와 간단한 이벤트.

import { STOCKS } from "../../shared/stocks";
import type { FeedItem, PositionInfo, TradeRecord, UserInfo } from "../../shared/protocol";
import type { Connection } from "./connection";

export interface Account {
  cash: number;
  positions: PositionInfo[];
  bailoutLeft: number;
  stars: number;
  lotteryLeft: number;
}

type Evt = "account" | "stock" | "feed" | "trades" | "fav" | "market" | "ref" | "view";
type Fn = () => void;

function loadFav(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem("dg.fav") ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}

class Store {
  user: UserInfo | null = null;
  conn: Connection | null = null;
  stock = STOCKS[0].id;
  market: "stock" | "coin" = "stock";
  view: "trade" | "rank" | "lottery" | "more" = "trade";
  account: Account = { cash: 0, positions: [], bailoutLeft: 0, stars: 0, lotteryLeft: 0 };
  feed: FeedItem[] = []; // 최신순
  feedOn = localStorage.getItem("dg.feedOff") !== "1";
  trades: TradeRecord[] = [];
  favorites = loadFav();
  online = 0;
  autoSelect = false; // 코드가 종목을 자동으로 바꾸는 중 (사용자가 고른 것과 구분)
  refPrice: number | null = null; // 호가창에서 클릭한 참고 가격
  order: number[] = []; // 종목 목록에 보이는 순서 (↑/↓ 이동용)

  private fns = new Map<Evt, Set<Fn>>();

  on(evt: Evt, fn: Fn): void {
    if (!this.fns.has(evt)) this.fns.set(evt, new Set());
    this.fns.get(evt)!.add(fn);
  }

  emit(evt: Evt): void {
    this.fns.get(evt)?.forEach((f) => f());
  }

  /** 앱을 다시 마운트할 때(로그아웃 후 재로그인) 구독을 초기화 */
  reset(): void {
    this.fns.clear();
    this.account = { cash: 0, positions: [], bailoutLeft: 0, stars: 0, lotteryLeft: 0 };
    this.feed = [];
    this.trades = [];
    this.refPrice = null;
    this.view = "trade";
  }

  setStock(id: number): void {
    if (id === this.stock) return;
    this.stock = id;
    this.refPrice = null;
    this.emit("stock");
  }

  setView(v: "trade" | "rank" | "lottery" | "more"): void {
    if (v === this.view) return;
    this.view = v;
    this.emit("view");
  }

  setMarket(m: "stock" | "coin"): void {
    if (m === this.market) return;
    this.market = m;
    this.emit("market");
  }

  toggleFav(id: number): void {
    if (this.favorites.has(id)) this.favorites.delete(id);
    else this.favorites.add(id);
    localStorage.setItem("dg.fav", JSON.stringify([...this.favorites]));
    this.emit("fav");
  }

  setFeedOn(on: boolean): void {
    this.feedOn = on;
    localStorage.setItem("dg.feedOff", on ? "0" : "1");
    this.emit("feed");
  }

  setRef(price: number | null): void {
    this.refPrice = price;
    this.emit("ref");
  }

  /** 종목 목록의 보이는 순서에서 한 칸 이동 */
  moveStock(delta: number): void {
    if (this.order.length === 0) return;
    const i = this.order.indexOf(this.stock);
    const next = this.order[(i + delta + this.order.length) % this.order.length];
    this.setStock(next);
  }

  position(stock: number, side: "long" | "short"): PositionInfo | undefined {
    return this.account.positions.find((p) => p.stock === stock && p.side === side);
  }
}

export const store = new Store();
