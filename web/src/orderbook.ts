import { BOOK_LEVELS, buildBook } from "../../shared/orderbook";
import { getStock } from "../../shared/stocks";
import { el, setClass, setText } from "./dom";
import { pct, shortQty, won } from "./format";
import { book } from "./pricebook";
import { store } from "./store";

interface Line {
  row: HTMLElement;
  price: HTMLElement;
  qty: HTMLElement;
  bar: HTMLElement;
  p: number;
}

/** 호가창 (표시용 가상 호가). 매도(파랑) 위, 현재가, 매수(빨강) 아래. 클릭하면 주문 패널에 참고 가격으로 전달. */
export function createOrderbook(): { el: HTMLElement; tick: () => void } {
  const mkLine = (cls: string): Line => {
    const bar = el("div", { class: "ob-bar" });
    const price = el("span", { class: "num" }, "–");
    const qty = el("span", { class: "num muted" }, "–");
    const row = el("div", { class: `ob-row ${cls}` }, bar, price, qty);
    const line: Line = { row, price, qty, bar, p: 0 };
    row.onclick = () => { if (line.p) store.setRef(line.p); };
    return line;
  };
  const asks = Array.from({ length: BOOK_LEVELS }, () => mkLine("ask"));
  const bids = Array.from({ length: BOOK_LEVELS }, () => mkLine("bid"));
  const mid = el("div", { class: "ob-mid num" }, "–");
  const root = el(
    "div",
    { class: "panel orderbook" },
    el("div", { class: "panel-title" }, "호가"),
    el("div", { class: "ob-body" }, ...[...asks].reverse().map((l) => l.row), mid, ...bids.map((l) => l.row)),
  );
  let lastTick = -1;
  let lastStock = 0;

  const fill = (lines: Line[], levels: { price: number; qty: number }[], max: number) => {
    lines.forEach((l, i) => {
      const lv = levels[i];
      l.p = lv?.price ?? 0;
      setText(l.price, lv ? won(lv.price) : "");
      setText(l.qty, lv ? shortQty(lv.qty) : "");
      l.bar.style.width = lv ? `${Math.round((lv.qty / max) * 100)}%` : "0%";
    });
  };

  return {
    el: root,
    tick: () => {
      if (!book.ready) return;
      const t = book.currentTick();
      if (t === lastTick && store.stock === lastStock) return; // 호가는 tick마다 한 번만 갱신
      lastTick = t;
      lastStock = store.stock;
      const stock = getStock(store.stock);
      const price = book.priceNow(stock.id);
      const b = buildBook(stock, book.viewSeed, t, price);
      const max = Math.max(...b.asks.map((l) => l.qty), ...b.bids.map((l) => l.qty));
      fill(asks, b.asks, max);
      fill(bids, b.bids, max);
      const d = book.dayStat(stock.id);
      const diff = d && d.open ? (price - d.open) / d.open : 0;
      setText(mid, `${won(price)}  ${pct(diff)}`);
      setClass(mid, `ob-mid num ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`);
    },
  };
}
