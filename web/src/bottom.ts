import { getStock } from "../../shared/stocks";
import { positionEquity } from "../../shared/trading";
import { el, syncRows, type RowSpec } from "./dom";
import { pct, shortQty, signed, timeText, tone, won } from "./format";
import { book } from "./pricebook";
import { store } from "./store";

type Tab = "pos" | "trades" | "feed";

const ACTION: Record<string, string> = { buy: "매수", sell: "매도", short: "공매도", cover: "환매", liquidation: "강제청산", prestige: "프레스티지", lottery: "복권" };
const actionTone = (a: string): string => (a === "buy" || a === "cover" || a === "lottery" ? "up" : a === "liquidation" || a === "prestige" ? "warn-text" : "down");
const nameOf = (id: number): string => {
  if (id === 0) return "–";
  try { return getStock(id).name; } catch { return String(id); }
};

/** 하단 탭: 보유 · 거래내역 · 체결 피드 */
export function createBottom(): { el: HTMLElement; tick: () => void } {
  let tab: Tab = "pos";
  const tabEls = new Map<Tab, HTMLElement>();
  const tabsEl = el("div", { class: "tabs" });
  for (const [k, label] of [["pos", "보유"], ["trades", "거래내역"], ["feed", "체결 피드"]] as [Tab, string][]) {
    const b = el("button", { class: "tab", type: "button" }, label);
    b.onclick = () => { tab = k; if (k === "trades") store.conn?.send({ t: "trades" }); render(); };
    tabEls.set(k, b);
    tabsEl.appendChild(b);
  }
  const feedToggle = el("label", { class: "feed-toggle muted" });
  const cb = el("input", { type: "checkbox", checked: store.feedOn });
  cb.onchange = () => store.setFeedOn(cb.checked);
  feedToggle.appendChild(cb);
  feedToggle.appendChild(document.createTextNode(" 실시간 피드 표시"));
  const head = el("div", { class: "bt-head" }, tabsEl, el("div", { class: "spacer" }), feedToggle);

  const mkTable = (cols: string[]) => {
    const tbody = el("tbody");
    const table = el("table", { class: "grid" }, el("thead", {}, el("tr", {}, ...cols.map((c, i) => el("th", { class: i < 2 ? "" : "num" }, c)))), tbody);
    return { wrap: el("div", { class: "bt-scroll" }, table), tbody };
  };
  const pos = mkTable(["종목", "구분", "수량", "평균가", "현재가", "평가손익", "수익률", "청산가"]);
  const trades = mkTable(["시간", "종목", "구분", "수량", "체결가", "수수료", "실현손익"]);
  const feedList = el("div", { class: "bt-scroll feed" });
  const body = el("div", { class: "bt-body" }, pos.wrap, trades.wrap, feedList);
  const root = el("div", { class: "panel bottom" }, head, body);

  function renderPos(): void {
    const rows: RowSpec[] = store.account.positions.map((p) => {
      const price = book.ready ? book.priceNow(p.stock) : p.cost / p.qty;
      const pnl = positionEquity(p, price) - p.margin;
      const ratio = p.margin ? pnl / p.margin : 0;
      return {
        key: `${p.stock}:${p.side}`,
        cls: p.stock === store.stock ? "selected" : "",
        onClick: () => store.setStock(p.stock),
        cells: [
          { text: nameOf(p.stock) },
          { text: p.side === "long" ? `롱${p.leverage > 1 ? ` ${p.leverage}x` : ""}` : "숏", cls: p.side === "long" ? "up" : "down" },
          { text: won(p.qty), cls: "num" },
          { text: won(p.cost / p.qty), cls: "num" },
          { text: won(price), cls: "num" },
          { text: signed(pnl), cls: `num ${tone(pnl)}` },
          { text: pct(ratio), cls: `num ${tone(pnl)}` },
          { text: p.liqPrice ? won(p.liqPrice) : "–", cls: "num warn-text" },
        ],
      };
    });
    syncRows(pos.tbody, rows, "보유 중인 종목이 없습니다.");
  }

  function renderTrades(): void {
    const rows: RowSpec[] = store.trades.map((t, i) => ({
      key: `${t.ts}:${i}`,
      cells: [
        { text: timeText(t.ts), cls: "muted" },
        { text: nameOf(t.stock) },
        { text: `${ACTION[t.action] ?? t.action}${t.leverage > 1 ? ` ${t.leverage}x` : ""}`, cls: actionTone(t.action) },
        { text: t.action === "prestige" ? `★${t.qty}` : won(t.qty), cls: "num" },
        { text: t.action === "prestige" || t.action === "lottery" ? "–" : won(t.price), cls: "num" },
        { text: won(t.fee), cls: "num muted" },
        { text: t.pnl === null ? "–" : signed(t.pnl), cls: `num ${t.pnl === null ? "muted" : tone(t.pnl)}` },
      ],
    }));
    syncRows(trades.tbody, rows, "거래 내역이 없습니다.");
  }

  let feedSig = "";
  function renderFeed(): void {
    if (!store.feedOn) {
      if (feedSig !== "off") { feedList.replaceChildren(el("div", { class: "muted empty" }, "피드가 꺼져 있습니다.")); feedSig = "off"; }
      return;
    }
    const sig = store.feed.length ? `${store.feed[0].ts}:${store.feed.length}` : "empty";
    if (sig === feedSig) return;
    feedSig = sig;
    if (!store.feed.length) { feedList.replaceChildren(el("div", { class: "muted empty" }, "아직 체결이 없습니다.")); return; }
    feedList.replaceChildren(
      ...store.feed.map((f) =>
        f.action === "prestige" || f.action === "lottery"
          ? el(
              "div",
              { class: "feed-row" },
              el("span", { class: "muted num" }, timeText(f.ts)),
              el("span", { class: "warn-text" }, f.action === "prestige" ? `${f.nick} 님이 프레스티지 ★${f.qty} 달성!` : `${f.nick} 님이 복권 ${won(f.qty)}원 당첨!`),
            )
          : el(
          "div",
          { class: "feed-row" },
          el("span", { class: "muted num" }, timeText(f.ts)),
          el("span", {}, `${f.nick} · ${nameOf(f.stock)} · `),
          el("span", { class: actionTone(f.action) }, `${ACTION[f.action] ?? f.action}`),
          el("span", {}, ` · ${shortQty(f.qty)}주`),
          el("span", { class: "muted num" }, ` @ ${won(f.price)}`),
        ),
      ),
    );
  }

  function render(): void {
    for (const [k, b] of tabEls) b.setAttribute("aria-selected", String(k === tab));
    pos.wrap.hidden = tab !== "pos";
    trades.wrap.hidden = tab !== "trades";
    feedList.hidden = tab !== "feed";
    feedToggle.hidden = tab !== "feed";
    if (tab === "pos") renderPos();
    else if (tab === "trades") renderTrades();
    else renderFeed();
  }

  store.on("account", render);
  store.on("trades", render);
  store.on("feed", () => { feedSig = ""; cb.checked = store.feedOn; render(); });
  store.on("stock", render);
  render();

  return {
    el: root,
    tick: () => { if (tab === "pos") renderPos(); },
  };
}
