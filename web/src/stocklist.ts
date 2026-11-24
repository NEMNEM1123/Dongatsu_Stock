import { STOCKS } from "../../shared/stocks";
import { el, setClass, setText } from "./dom";
import { pct, shortQty, won } from "./format";
import { book } from "./pricebook";
import { store } from "./store";

type SortKey = "name" | "price" | "chg" | "vol";

interface RowRef {
  row: HTMLElement;
  star: HTMLElement;
  price: HTMLElement;
  chg: HTMLElement;
  vol: HTMLElement;
  last: number;
}

/** 왼쪽 종목 목록: 검색, 관심/전체, 클릭 정렬, 관심 별표 */
export function createStockList(): { el: HTMLElement; tick: () => void } {
  let tab: "all" | "fav" = "all";
  let query = "";
  let sortKey: SortKey = "name";
  let sortDir = 1;
  let frame = 0;

  const search = el("input", { class: "input", placeholder: "종목 검색", type: "search" });
  const tabAll = el("button", { class: "tab", type: "button" }, "전체");
  const tabFav = el("button", { class: "tab", type: "button" }, "관심");
  const colBtns = new Map<SortKey, HTMLElement>();
  const cols = el("div", { class: "sl-cols" });
  const defs: [SortKey, string, string][] = [["name", "이름", "c-name"], ["price", "현재가", "c-price"], ["chg", "등락률", "c-chg"], ["vol", "거래량", "c-vol"]];
  for (const [k, label, cls] of defs) {
    const b = el("button", { class: `sl-col ${cls}`, type: "button" }, label);
    b.onclick = () => {
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = k === "name" ? 1 : -1; }
      render(true);
    };
    colBtns.set(k, b);
    cols.appendChild(b);
  }
  // 모바일에서는 상단 탭이 없으므로 목록 안에서 주식/코인을 전환한다
  const mkBtns = new Map<"stock" | "coin", HTMLElement>();
  const marketTabs = el("div", { class: "tabs sl-market" });
  for (const [k, label] of [["stock", "주식"], ["coin", "코인"]] as ["stock" | "coin", string][]) {
    const b = el("button", { class: "tab", type: "button" }, label);
    b.onclick = () => store.setMarket(k);
    mkBtns.set(k, b);
    marketTabs.appendChild(b);
  }
  const syncMarketTabs = () => { for (const [k, b] of mkBtns) b.setAttribute("aria-selected", String(k === store.market)); };
  const body = el("div", { class: "sl-body" });
  const root = el(
    "div",
    { class: "panel stocklist" },
    el("div", { class: "sl-head" }, search),
    marketTabs,
    el("div", { class: "tabs" }, tabAll, tabFav),
    cols,
    body,
  );

  const refs = new Map<number, RowRef>();
  for (const s of STOCKS) {
    const star = el("button", { class: "star", type: "button", title: "관심 종목" }, "★");
    star.onclick = (e) => { e.stopPropagation(); store.toggleFav(s.id); };
    const price = el("span", { class: "c-price num" }, "–");
    const chg = el("span", { class: "c-chg num" }, "–");
    const vol = el("span", { class: "c-vol num muted" }, "–");
    const row = el(
      "div",
      { class: "sl-row" },
      star,
      el("span", { class: "c-name", title: `${s.name} (${s.code})` }, s.name),
      price, chg, vol,
    );
    row.onclick = () => store.setStock(s.id);
    refs.set(s.id, { row, star, price, chg, vol, last: 0 });
  }

  const stats = (id: number) => {
    const price = book.ready ? book.priceNow(id) : 0;
    const d = book.ready ? book.dayStat(id) : undefined;
    const chg = d && d.open > 0 ? (price - d.open) / d.open : 0;
    return { price, chg, vol: d?.volume ?? 0 };
  };

  function render(force = false): void {
    setClass(tabAll, "tab"); tabAll.setAttribute("aria-selected", String(tab === "all"));
    tabFav.setAttribute("aria-selected", String(tab === "fav"));
    for (const [k, b] of colBtns) {
      const base = b.className.split(" ").filter((c) => c.startsWith("sl-col") || c.startsWith("c-")).join(" ");
      setText(b, defs.find((d) => d[0] === k)![1] + (k === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : ""));
      setClass(b, base + (k === sortKey ? " active" : ""));
    }
    const q = query.trim().toLowerCase();
    let list = STOCKS.filter((s) => (store.market === "coin" ? s.kind === "coin" : s.kind === "stock"));
    if (tab === "fav") list = list.filter((s) => store.favorites.has(s.id));
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));
    const st = new Map(list.map((s) => [s.id, stats(s.id)]));
    list = [...list].sort((a, b) => {
      const x = st.get(a.id)!, y = st.get(b.id)!;
      const cmp = sortKey === "name" ? a.name.localeCompare(b.name, "ko") : sortKey === "price" ? x.price - y.price : sortKey === "chg" ? x.chg - y.chg : x.vol - y.vol;
      return (cmp || a.id - b.id) * sortDir;
    });
    store.order = list.map((s) => s.id);

    if (force || body.children.length !== list.length || list.some((s, i) => body.children[i] !== refs.get(s.id)!.row)) {
      if (list.length === 0) body.replaceChildren(el("div", { class: "muted empty" }, tab === "fav" ? "관심 종목이 없습니다. ★을 눌러 추가하세요." : "검색 결과가 없습니다."));
      else body.replaceChildren(...list.map((s) => refs.get(s.id)!.row));
    }
    for (const s of list) {
      const r = refs.get(s.id)!;
      const v = st.get(s.id)!;
      setText(r.price, book.ready ? won(v.price) : "–");
      setText(r.chg, book.ready ? pct(v.chg) : "–");
      setClass(r.chg, `c-chg num ${v.chg > 0 ? "up" : v.chg < 0 ? "down" : ""}`);
      setText(r.vol, book.ready ? shortQty(v.vol) : "–");
      if (r.last && v.price !== r.last) {
        r.price.classList.remove("flash-up", "flash-down");
        void r.price.offsetWidth; // 애니메이션 재시작
        r.price.classList.add(v.price > r.last ? "flash-up" : "flash-down");
      }
      r.last = v.price;
      setClass(r.star, `star${store.favorites.has(s.id) ? " on" : ""}`);
      setClass(r.row, `sl-row${s.id === store.stock ? " selected" : ""}`);
    }
  }

  tabAll.onclick = () => { tab = "all"; render(true); };
  tabFav.onclick = () => { tab = "fav"; render(true); };
  search.oninput = () => { query = search.value; render(true); };
  store.on("fav", () => render());
  store.on("stock", () => render());
  store.on("market", () => {
    syncMarketTabs();
    const first = STOCKS.find((s) => (store.market === "coin" ? s.kind === "coin" : s.kind === "stock"));
    if (first && STOCKS.find((s) => s.id === store.stock)?.kind !== first.kind) {
      store.autoSelect = true;
      store.setStock(first.id);
      store.autoSelect = false;
    }
    render(true);
  });
  syncMarketTabs();
  render(true);

  return {
    el: root,
    tick: () => {
      // 가격 칸은 매번, 정렬 순서는 1초마다 다시 계산 (클릭 중 행이 움직이지 않도록)
      frame++;
      if (frame % 5 === 0) render();
      else {
        for (const id of store.order) {
          const r = refs.get(id)!;
          const v = stats(id);
          setText(r.price, book.ready ? won(v.price) : "–");
          if (r.last && v.price !== r.last) {
            r.price.classList.remove("flash-up", "flash-down");
            void r.price.offsetWidth;
            r.price.classList.add(v.price > r.last ? "flash-up" : "flash-down");
          }
          r.last = v.price;
        }
      }
    },
  };
}
