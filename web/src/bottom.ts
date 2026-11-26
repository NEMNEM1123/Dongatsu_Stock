import { RULES } from "../../shared/rules";
import { getStock } from "../../shared/stocks";
import type { PositionInfo } from "../../shared/protocol";
import { positionEquity } from "../../shared/trading";
import { el, syncRows, type RowSpec } from "./dom";
import { pct, shortQty, signed, timeText, tone, won } from "./format";
import { book } from "./pricebook";
import { store } from "./store";
import { toast } from "./toast";
import { createQuestPanel, createReservePanel, createStatsPanel, type Panel } from "./panels";

const CLOSE_GAP_MS = 300; // 서버가 초당 주문 수를 제한하므로 간격을 두고 보낸다
const CONFIRM_MS = 3000;

type Tab = "pos" | "reserve" | "trades" | "stats" | "quest" | "feed";

const ACTION: Record<string, string> = { buy: "매수", sell: "매도", short: "공매도", cover: "환매", liquidation: "강제청산", prestige: "프레스티지", lottery: "복권", puzzle: "퍼즐" };
const actionTone = (a: string): string => (a === "buy" || a === "cover" || a === "lottery" || a === "puzzle" ? "up" : a === "liquidation" || a === "prestige" ? "warn-text" : "down");
const nameOf = (id: number): string => {
  if (id === 0) return "–";
  try { return getStock(id).name; } catch { return String(id); }
};

/** 하단 탭: 보유 · 거래내역 · 체결 피드 */
export function createBottom(): { el: HTMLElement; tick: () => void } {
  let tab: Tab = "pos";
  const tabEls = new Map<Tab, HTMLElement>();
  const tabsEl = el("div", { class: "tabs" });
  const reservePanel = createReservePanel();
  const statsPanel = createStatsPanel();
  const questPanel = createQuestPanel();
  const panels: Partial<Record<Tab, Panel>> = { reserve: reservePanel, stats: statsPanel, quest: questPanel };
  for (const [k, label] of [["pos", "보유"], ["reserve", "예약"], ["trades", "거래내역"], ["stats", "내 성적"], ["quest", "미션"], ["feed", "체결 피드"]] as [Tab, string][]) {
    const b = el("button", { class: "tab", type: "button" }, label);
    b.onclick = () => { tab = k; if (k === "trades") store.conn?.send({ t: "trades" }); panels[k]?.open(); render(); };
    tabEls.set(k, b);
    tabsEl.appendChild(b);
  }
  const feedToggle = el("label", { class: "feed-toggle muted" });
  const cb = el("input", { type: "checkbox", checked: store.feedOn });
  cb.onchange = () => store.setFeedOn(cb.checked);
  feedToggle.appendChild(cb);
  feedToggle.appendChild(document.createTextNode(" 실시간 피드 표시"));
  // 청산 버튼: 한 번 누르면 "한 번 더 눌러 확인"으로 바뀌고 3초 안에 다시 눌러야 실행된다
  const mkCloseBtn = (label: string, pick: () => PositionInfo[]) => {
    const b = el("button", { class: "btn bt-act", type: "button" }, label);
    let armedTimer: number | undefined;
    b.onclick = () => {
      if (armedTimer === undefined) {
        if (pick().length === 0) { toast("청산할 포지션이 없습니다.", "warn"); return; }
        b.textContent = "한 번 더 눌러 확인";
        armedTimer = window.setTimeout(() => { armedTimer = undefined; b.textContent = label; }, CONFIRM_MS);
        return;
      }
      clearTimeout(armedTimer);
      armedTimer = undefined;
      b.textContent = label;
      closePositions(pick());
    };
    return b;
  };
  const closeSel = mkCloseBtn("선택 종목 청산", () => store.account.positions.filter((p) => p.stock === store.stock));
  const closeAll = mkCloseBtn("전체 청산", () => store.account.positions);
  const closeBox = el("div", { class: "bt-acts" }, closeSel, closeAll);
  const head = el("div", { class: "bt-head" }, tabsEl, el("div", { class: "spacer" }), closeBox, feedToggle);

  /** 포지션을 전량 정리하는 주문을 간격을 두고 보낸다 (롱은 매도, 숏은 환매). 체결 결과는 기존 order 토스트로 표시된다. */
  function closePositions(list: PositionInfo[]): void {
    const targets = list.map((p) => ({ stock: p.stock, qty: p.qty, action: p.side === "long" ? ("sell" as const) : ("cover" as const) }));
    targets.forEach((t, i) => {
      window.setTimeout(() => {
        const px = book.ready ? book.priceNow(t.stock) : 0;
        const sent = store.conn?.send({ t: "order", id: Date.now() + i, stock: t.stock, action: t.action, qty: t.qty, px });
        if (!sent) toast(`${nameOf(t.stock)} 청산 요청을 보내지 못했습니다. 연결을 확인하세요.`, "warn");
      }, i * CLOSE_GAP_MS);
    });
  }

  // 청산가 근접 경고: 가까워지면 한 번 알리고, 충분히 멀어지면 다시 알릴 수 있게 한다
  const liqWarned = new Set<string>();
  const liqGap = (p: PositionInfo, price: number): number | null =>
    !p.liqPrice || price <= 0 ? null : p.side === "long" ? (price - p.liqPrice) / price : (p.liqPrice - price) / price;

  const mkTable = (cols: string[]) => {
    const tbody = el("tbody");
    const table = el("table", { class: "grid" }, el("thead", {}, el("tr", {}, ...cols.map((c, i) => el("th", { class: i < 2 ? "" : "num" }, c)))), tbody);
    return { wrap: el("div", { class: "bt-scroll" }, table), tbody };
  };
  const pos = mkTable(["종목", "구분", "수량", "평균가", "현재가", "평가손익", "수익률", "청산가"]);
  const trades = mkTable(["시간", "종목", "구분", "수량", "체결가", "수수료", "실현손익"]);
  const feedList = el("div", { class: "bt-scroll feed" });
  const body = el("div", { class: "bt-body" }, pos.wrap, reservePanel.el, trades.wrap, statsPanel.el, questPanel.el, feedList);
  const root = el("div", { class: "panel bottom" }, head, body);

  /** 어느 탭을 보고 있든 경고는 띄운다 */
  function checkLiq(): void {
    if (!book.ready) return;
    const seen = new Set<string>();
    for (const p of store.account.positions) {
      const key = `${p.stock}:${p.side}`;
      seen.add(key);
      const gap = liqGap(p, book.priceNow(p.stock));
      if (gap !== null && gap < RULES.LIQ_WARN_RATIO) {
        if (!liqWarned.has(key)) {
          liqWarned.add(key);
          toast(`${nameOf(p.stock)} ${p.side === "long" ? "롱" : "숏"} 청산가까지 ${(gap * 100).toFixed(1)}% 남았습니다.`, "warn", 6000);
        }
      } else if (gap === null || gap > RULES.LIQ_WARN_RATIO * 1.6) liqWarned.delete(key);
    }
    for (const k of liqWarned) if (!seen.has(k)) liqWarned.delete(k); // 정리된 포지션
  }

  function renderPos(): void {
    const rows: RowSpec[] = store.account.positions.map((p) => {
      const price = book.ready ? book.priceNow(p.stock) : p.cost / p.qty;
      const pnl = positionEquity(p, price) - p.margin;
      const ratio = p.margin ? pnl / p.margin : 0;
      const key = `${p.stock}:${p.side}`;
      const gap = liqGap(p, price);
      const near = gap !== null && gap < RULES.LIQ_WARN_RATIO;
      return {
        key,
        cls: `${p.stock === store.stock ? "selected" : ""}${near ? " liq-near" : ""}`.trim(),
        onClick: () => store.setStock(p.stock),
        cells: [
          { text: nameOf(p.stock) },
          { text: `${p.side === "long" ? "롱" : "숏"}${p.leverage > 1 ? ` ${p.leverage}x` : ""}`, cls: p.side === "long" ? "up" : "down" },
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
        { text: t.action === "prestige" || t.action === "lottery" || t.action === "puzzle" ? "–" : won(t.price), cls: "num" },
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
        f.action === "prestige" || f.action === "lottery" || f.action === "puzzle"
          ? el(
              "div",
              { class: "feed-row" },
              el("span", { class: "muted num" }, timeText(f.ts)),
              el("span", { class: "warn-text" }, f.action === "prestige" ? `${f.nick} 님이 프레스티지 ★${f.qty} 달성!` : f.action === "puzzle" ? `${f.nick} 님이 블록 채우기로 ${won(f.qty)}원 획득!` : `${f.nick} 님이 복권 ${won(f.qty)}원 당첨!`),
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
    reservePanel.el.hidden = tab !== "reserve";
    statsPanel.el.hidden = tab !== "stats";
    questPanel.el.hidden = tab !== "quest";
    feedList.hidden = tab !== "feed";
    feedToggle.hidden = tab !== "feed";
    closeBox.hidden = tab !== "pos";
    if (tab === "pos") renderPos();
    else if (tab === "trades") renderTrades();
    else renderFeed();
  }

  store.on("account", render);
  store.on("trades", () => {
    render();
    panels[tab]?.open(); // 거래가 생기면 성적·미션 탭은 다시 불러온다
  });
  store.on("feed", () => { feedSig = ""; cb.checked = store.feedOn; render(); });
  store.on("stock", render);
  render();

  return {
    el: root,
    tick: () => { checkLiq(); if (tab === "pos") renderPos(); },
  };
}
