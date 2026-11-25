import { getStock } from "../../shared/stocks";
import { netWorth } from "../../shared/trading";
import { el, setClass, setText } from "./dom";
import { bigWon, pct, shortQty, signed, won } from "./format";
import { patchUnseen } from "./patch";
import { book } from "./pricebook";
import { store } from "./store";
import { toast } from "./toast";

/** 상단 바: 로고 · 탭 · 접속자 · 내 순자산 */
export function createTopbar(onLogout: () => void): { el: HTMLElement; tick: () => void; setOnline: (n: number) => void } {
  const tabs: [string, string][] = [["stock", "거래소"], ["coin", "코인"], ["etf", "ETF"], ["macho", "상남자"], ["lottery", "복권"], ["puzzle", "퍼즐"], ["job", "알바"], ["rank", "순위"], ["help", "사용법"], ["more", "더보기"]];
  const tabEls = new Map<string, HTMLElement>();
  const nav = el("nav", { class: "nav" });
  for (const [key, label] of tabs) {
    const b = el("button", { class: "nav-tab", type: "button" }, label);
    b.onclick = () => {
      if (key === "stock" || key === "coin" || key === "etf" || key === "macho") {
        store.setView("trade");
        store.setMarket(key);
      } else if (key === "rank") store.setView("rank");
      else if (key === "lottery") store.setView("lottery");
      else if (key === "puzzle") store.setView("puzzle");
      else if (key === "job") store.setView("job");
      else if (key === "help") store.openHelp(store.helpTab);
      else if (key === "more") store.setView("more");
      else toast(`${label}은(는) 준비 중입니다.`);
    };
    tabEls.set(key, b);
    nav.appendChild(b);
  }
  const nickEl = el("div", { class: "nick" }, store.user?.nickname ?? "");
  const online = el("span", { class: "num" }, "–");
  const worth = el("span", { class: "num worth" }, "–");
  const logout = el("button", { class: "btn tb-logout", type: "button" }, "로그아웃");
  logout.onclick = onLogout;
  const root = el(
    "header",
    { class: "topbar" },
    el("div", { class: "logo" }, "돈까스거래소"),
    nav,
    el("div", { class: "spacer" }),
    el("div", { class: "muted tb-online" }, "접속자 ", online, "명"),
    el("div", { class: "muted tb-worth" }, "내 순자산 ", worth),
    nickEl,
    logout,
  );
  const sync = () => {
    const current = store.view === "trade" ? store.market : store.view; // 거래 화면은 주식/코인 탭, 나머지는 같은 이름의 탭
    for (const [k, b] of tabEls) {
      b.setAttribute("aria-selected", String(k === current));
      b.classList.toggle("has-dot", k === "help" && patchUnseen()); // 안 읽은 패치노트 표시
    }
  };
  store.on("market", sync);
  store.on("view", sync);
  store.on("help", sync);
  sync();
  return {
    el: root,
    setOnline: (n) => setText(online, String(n)),
    tick: () => {
      if (!book.ready) return;
      const nw = netWorth(store.account.cash, store.account.positions, (id) => book.priceNow(id));
      setText(nickEl, `${store.user?.nickname ?? ""}${store.account.stars ? ` ★${store.account.stars}` : ""}`);
      setText(worth, bigWon(nw));
      worth.title = `${won(nw)}원`;
    },
  };
}

/** 종목 정보 바: 종목명 · 현재가(크게) · 등락률 · 고가 · 저가 · 거래량 */
export function createInfobar(): { el: HTMLElement; tick: () => void } {
  const name = el("div", { class: "ib-name" });
  const price = el("span", { class: "price-big num" }, "–");
  const chg = el("span", { class: "num ib-chg" }, "");
  const mk = (label: string) => {
    const v = el("span", { class: "num" }, "–");
    return { box: el("div", { class: "ib-stat" }, el("span", { class: "muted" }, label), v), v };
  };
  const hi = mk("고가"), lo = mk("저가"), vol = mk("거래량(일)"), open = mk("시가");
  const root = el("div", { class: "infobar panel" }, name, price, chg, hi.box, lo.box, open.box, vol.box);
  let last = 0;
  let lastId = 0;
  const sync = () => {
    const s = getStock(store.stock);
    setText(name, `${s.name} `);
    name.appendChild(el("small", { class: "muted" }, s.code));
    last = 0;
    lastId = store.stock;
  };
  store.on("stock", sync);
  sync();
  return {
    el: root,
    tick: () => {
      if (!book.ready) return;
      if (lastId !== store.stock) sync();
      const p = book.priceNow(store.stock);
      const d = book.dayStat(store.stock);
      if (!d) return;
      const diff = p - d.open;
      const cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
      setText(price, won(p));
      setClass(price, `price-big num ${cls}`);
      setText(chg, `${signed(diff)} (${pct(d.open ? diff / d.open : 0)})`);
      setClass(chg, `num ib-chg ${cls}`);
      setText(hi.v, won(d.high));
      setText(lo.v, won(d.low));
      setText(open.v, won(d.open));
      setText(vol.v, shortQty(d.volume));
      if (last && p !== last) {
        price.classList.remove("flash-up", "flash-down");
        void price.offsetWidth;
        price.classList.add(p > last ? "flash-up" : "flash-down");
      }
      last = p;
    },
  };
}
