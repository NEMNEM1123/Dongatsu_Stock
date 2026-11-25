import { INTERVAL_KEYS, type IntervalKey } from "../../shared/candles";
import type { UserInfo } from "../../shared/protocol";
import { getStock } from "../../shared/stocks";
import { RULES } from "../../shared/rules";
import { netWorth } from "../../shared/trading";
import { CLIENT_VERSION } from "../../shared/version";
import { createBottom } from "./bottom";
import { PriceChart } from "./chart";
import { Connection } from "./connection";
import { el } from "./dom";
import { won } from "./format";
import { createInfobar, createTopbar } from "./header";
import { createOrderbook } from "./orderbook";
import { createOrderPanel } from "./orderpanel";
import { book } from "./pricebook";
import { createMoreView } from "./admin";
import { createLotteryView } from "./lottery";
import { createPuzzleView } from "./puzzle";
import { createPartTimeView } from "./parttime";
import { createNewsStrip } from "./news";
import { hideOverlay, showOverlay } from "./overlay";
import { createRankView } from "./rank";
import { guideSeen, showGuide } from "./guide";
import { createHelpView } from "./help";
import { patchUnseen } from "./patch";
import { createStockList } from "./stocklist";
import { store } from "./store";
import { toast } from "./toast";

const ACTION_LABEL = { buy: "매수", sell: "매도", short: "공매도", cover: "환매" } as const;
const nameOf = (id: number): string => getStock(id).name;
const count0 = (m: { payouts: number[] }): number => m.payouts.length;

const ICON = {
  market: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  order: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  assets: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
} as const;

/** 선 아이콘 (Lucide 계열 모양을 직접 그려 넣어 외부 라이브러리 없이 쓴다. 고정 문자열만 사용) */
function icon(inner: string): SVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", "22");
  s.setAttribute("height", "22");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.innerHTML = inner;
  return s;
}

type MTab = "market" | "chart" | "order" | "assets";


/** 거래소 메인 화면. 반환 함수를 호출하면 정리(연결 종료·타이머 해제)한다. */
export function mountApp(root: HTMLElement, user: UserInfo, onLogout: () => void): () => void {
  store.reset();
  store.user = user;

  const conn = new Connection();
  store.conn = conn;
  let iv: IntervalKey = "1m";
  let mode: "candle" | "line" = "candle";

  // ── 화면 조립 ──
  const banner = el("div", { class: "banner-warn", hidden: true }, "연결이 끊겼습니다. 다시 연결하는 중…");
  const topbar = createTopbar(() => onLogout());
  const bailout = el("button", { class: "btn btn-primary", type: "button", hidden: true }, "파산 구제");
  bailout.onclick = () => conn.send({ t: "bailout" });
  const prestige = el("button", { class: "btn btn-primary", type: "button", hidden: true }, "프레스티지");
  let prestigeArmed: number | undefined;
  prestige.onclick = () => {
    if (prestigeArmed === undefined) {
      prestige.textContent = "모든 자산이 초기화됩니다 — 한 번 더 눌러 확인";
      prestigeArmed = window.setTimeout(() => { prestigeArmed = undefined; prestige.textContent = "프레스티지"; }, 4000);
      return;
    }
    clearTimeout(prestigeArmed);
    prestigeArmed = undefined;
    prestige.textContent = "프레스티지";
    conn.send({ t: "prestige" });
  };
  topbar.el.insertBefore(bailout, topbar.el.querySelector(".nick"));
  topbar.el.insertBefore(prestige, topbar.el.querySelector(".nick"));
  const infobar = createInfobar();
  const list = createStockList();
  const orderbook = createOrderbook();
  const panel = createOrderPanel();
  const bottom = createBottom();

  const legend = el("div", { class: "chart-legend num" });
  const chartHost = el("div", { class: "chart-host" });
  const toolbar = el("div", { class: "chart-toolbar" });
  const ivBtns = INTERVAL_KEYS.map((k) => {
    const b = el("button", { class: "tab", type: "button" }, { "1m": "1분", "5m": "5분", "1h": "1시간", "1d": "1일" }[k]);
    b.onclick = () => { iv = k; reselect(); };
    return [k, b] as const;
  });
  const modeBtn = el("button", { class: "btn", type: "button" }, "라인");
  for (const [, b] of ivBtns) toolbar.appendChild(b);
  toolbar.appendChild(el("div", { class: "spacer" }));
  toolbar.appendChild(modeBtn);
  const chartPanel = el("div", { class: "panel chart-panel" }, toolbar, el("div", { class: "chart-wrap" }, chartHost, legend));
  const chart = new PriceChart(chartHost, legend);
  modeBtn.onclick = () => {
    mode = mode === "candle" ? "line" : "candle";
    modeBtn.textContent = mode === "candle" ? "라인" : "캔들";
    chart.setMode(mode);
  };

  // 1024~1280px: 호가창을 주문 패널과 탭으로 합침 (CSS가 data-rt 값으로 하나만 보여 줌)
  const right = el("div", { class: "col-right" });
  right.dataset.rt = "order";
  const rtBook = el("button", { class: "tab", type: "button" }, "호가");
  const rtOrder = el("button", { class: "tab", type: "button" }, "주문");
  const syncRt = () => {
    rtBook.setAttribute("aria-selected", String(right.dataset.rt === "book"));
    rtOrder.setAttribute("aria-selected", String(right.dataset.rt === "order"));
  };
  rtBook.onclick = () => { right.dataset.rt = "book"; syncRt(); };
  rtOrder.onclick = () => { right.dataset.rt = "order"; syncRt(); };
  syncRt();
  // 모바일: 주문은 하단 탭 바에서 여는 바텀 시트 (시트 머리말은 데스크톱에서는 숨김)
  const sheetTitle = el("span", { class: "sheet-title" });
  const sheetClose = el("button", { class: "btn", type: "button" }, "닫기");
  const sheetHead = el("div", { class: "sheet-head" }, sheetTitle, el("div", { class: "spacer" }), sheetClose);
  for (const n of [sheetHead, el("div", { class: "tabs rt-tabs" }, rtBook, rtOrder), orderbook.el, panel.el]) right.appendChild(n);

  const rank = createRankView();
  const layout = el("main", { class: "layout" }, el("div", { class: "col-left" }, list.el), el("div", { class: "col-center" }, chartPanel, bottom.el), right);
  const rankWrap = el("main", { class: "rank-wrap", hidden: true }, rank.el);
  const lottery = createLotteryView();
  const lotteryWrap = el("main", { class: "rank-wrap", hidden: true }, lottery.el);
  const puzzle = createPuzzleView();
  const puzzleWrap = el("main", { class: "rank-wrap", hidden: true }, puzzle.el);
  const job = createPartTimeView();
  const jobWrap = el("main", { class: "rank-wrap", hidden: true }, job.el);
  const more = createMoreView({ onLogout, openGuide: showGuide });
  const moreWrap = el("main", { class: "rank-wrap more-wrap", hidden: true }, more.el);
  const help = createHelpView();
  const helpWrap = el("main", { class: "rank-wrap help-wrap", hidden: true }, help.el);
  const news = createNewsStrip();

  // 모바일 자산 탭 상단 요약 (데스크톱에서는 숨김)
  const assetsInfo = el("div", { class: "panel assets-summary num" });
  layout.querySelector(".col-center")!.insertBefore(assetsInfo, bottom.el);

  // ── 모바일: 하단 탭 바 (시장 · 차트 · 주문 · 자산 · 더보기) ──
  const mq = window.matchMedia("(max-width: 900px)");
  let mtab: MTab = "market";
  layout.dataset.mtab = mtab;
  const backdrop = el("div", { class: "sheet-backdrop", hidden: true });
  const tabbar = el("nav", { class: "mtabbar" });
  const barBtns = new Map<string, HTMLElement>();
  const barDefs: [string, string][] = [["market", "시장"], ["chart", "차트"], ["order", "주문"], ["assets", "자산"], ["more", "더보기"]];
  for (const [key, label] of barDefs) {
    const b = el("button", { class: "mtab", type: "button" });
    b.appendChild(icon(ICON[key as keyof typeof ICON]));
    b.appendChild(el("span", {}, label));
    b.onclick = () => (key === "more" ? store.setView("more") : openMtab(key as MTab));
    barBtns.set(key, b);
    tabbar.appendChild(b);
  }
  function syncBar(): void {
    const sel = store.view === "trade" ? mtab : "more";
    for (const [k, b] of barBtns) b.setAttribute("aria-selected", String(k === sel));
    backdrop.hidden = !(store.view === "trade" && mtab === "order");
  }
  function openMtab(t: MTab): void {
    mtab = t;
    layout.dataset.mtab = t;
    if (store.view !== "trade") store.setView("trade");
    syncBar();
  }
  sheetClose.onclick = () => openMtab("chart");
  backdrop.onclick = () => openMtab("chart");
  const syncSheetTitle = () => { sheetTitle.textContent = `${nameOf(store.stock)} 주문`; };
  syncSheetTitle();
  // 시장 탭에서 종목을 고르면 차트로 이동 (주식/코인 전환 때 자동으로 바뀌는 경우는 제외)
  store.on("stock", () => {
    syncSheetTitle();
    if (mq.matches && store.view === "trade" && mtab === "market" && !store.autoSelect) openMtab("chart");
  });

  root.classList.add("app-main");
  root.replaceChildren(banner, topbar.el, infobar.el, news.el, layout, rankWrap, lotteryWrap, puzzleWrap, jobWrap, moreWrap, helpWrap, backdrop, tabbar);
  syncBar();

  // 거래소 / 순위 / 복권 화면 전환
  store.on("view", () => {
    const v = store.view;
    infobar.el.hidden = v !== "trade";
    layout.hidden = v !== "trade";
    rankWrap.hidden = v !== "rank";
    lotteryWrap.hidden = v !== "lottery";
    puzzleWrap.hidden = v !== "puzzle";
    jobWrap.hidden = v !== "job";
    moreWrap.hidden = v !== "more";
    helpWrap.hidden = v !== "help";
    news.el.classList.toggle("off", v !== "trade");
    syncBar();
    if (v === "more") more.show();
    else more.hide();
    if (v === "rank") rank.show();
    else if (v === "trade") reselect(); // 차트가 숨겨진 동안 크기가 0이었으므로 다시 맞춘다
    else if (v === "help") help.show();
    else if (v === "puzzle") puzzle.show();
    else if (v === "job") job.show();
    else lottery.update();
  });

  // ── 차트 ──
  function reselect(): void {
    for (const [k, b] of ivBtns) b.setAttribute("aria-selected", String(k === iv));
    chart.select(store.stock, iv);
    if (conn.status === "open" && book.ready) conn.send({ t: "candles", stock: store.stock, iv, limit: 500 });
  }
  function syncLines(): void {
    const p = store.position(store.stock, "long") ?? store.position(store.stock, "short");
    chart.setLines(p ? p.cost / p.qty : null, p?.liqPrice ?? null);
  }
  store.on("stock", () => { reselect(); syncLines(); });
  store.on("account", syncLines);
  reselect();

  // ── 실시간 갱신 (가격은 클라이언트가 계산) ──
  const timer = window.setInterval(() => {
    if (!book.ready) return;
    topbar.tick();
    infobar.tick();
    list.tick();
    orderbook.tick();
    panel.tick();
    bottom.tick();
    const nw = netWorth(store.account.cash, store.account.positions, (id) => book.priceNow(id));
    bailout.hidden = !(nw <= 0 && store.account.bailoutLeft > 0);
    prestige.hidden = nw < RULES.PRESTIGE_NET_WORTH;
    assetsInfo.textContent = `현금 ${won(store.account.cash)}원 · 순자산 ${won(nw)}원${store.account.stars ? ` · ★${store.account.stars}` : ""}`;
  }, 200);

  // ── 단축키: B 매수, S 매도, ↑/↓ 종목 이동 ──
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "b") { panel.setTab("buy"); right.dataset.rt = "order"; syncRt(); }
    else if (k === "s") { panel.setTab("sell"); right.dataset.rt = "order"; syncRt(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); store.moveStock(-1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); store.moveStock(1); }
  };
  document.addEventListener("keydown", onKey);

  let guideShown = false;
  let patchToasted = false;

  // ── 점검 · 버전 안내 ──
  let serverState = { on: false, message: "", minVersion: 0 };
  function applyServerState(): void {
    if (CLIENT_VERSION < serverState.minVersion) {
      showOverlay("새 버전이 나왔습니다", "원활한 이용을 위해 페이지를 새로고침해 주세요.", { label: "새로고침", run: () => location.reload() });
    } else if (serverState.on && store.user?.role !== "admin") {
      showOverlay("점검 중입니다", serverState.message || "잠시 후 다시 이용해 주세요.");
    } else {
      hideOverlay();
    }
  }
  conn.onFatal = () => {
    showOverlay("이용이 제한된 계정입니다", "운영자에게 문의해 주세요.", { label: "로그아웃", run: () => onLogout() });
  };

  // ── 서버 메시지 ──
  conn.onStatus = (s) => {
    banner.hidden = s === "open";
    if (s === "closed") { puzzle.reset(); job.reset(); }
    if (s === "closed") lottery.reset(); // 응답을 기다리던 중 끊기면 버튼이 잠긴 채 남지 않게
  };
  conn.onMessage = (m) => {
    switch (m.t) {
      case "hello":
        store.online = m.online;
        topbar.setOnline(m.online);
        lottery.reset();
        puzzle.reset(); // 진행 중이던 판이 있으면 이어서 보여 준다
        job.reset(); // 진행 중이던 알바도 마찬가지
        conn.send({ t: "reserves" });
        book.init(m.epoch, m.tickMs, m.viewSeed, m.px, m.days);
        news.set(m.news);
        if (!guideSeen() && !guideShown) { guideShown = true; showGuide(); } // 첫 접속 사용법 안내
        else if (patchUnseen() && !patchToasted) {
          patchToasted = true;
          toast("새 패치노트가 있어요! 위쪽 '사용법' → '패치노트'에서 확인하세요.", "info", 8000);
        }
        serverState = { on: m.maintenance.on, message: m.maintenance.message, minVersion: m.minVersion };
        applyServerState();
        reselect(); // 재연결 시에도 봉을 다시 받아 상태를 복구한다
        break;
      case "news":
        news.add(m.item);
        toast(`[${nameOf(m.item.stock)}] ${m.item.headline}`, "warn", 8000);
        break;
      case "maintenance":
        serverState = { ...serverState, on: m.on, message: m.message };
        applyServerState();
        break;
      case "px":
        book.onPx(m.tick, m.p);
        chart.onPx(store.stock, m.tick, book.priceNow(store.stock));
        break;
      case "online":
        store.online = m.n;
        topbar.setOnline(m.n);
        break;
      case "candles":
        chart.onCandles(m.stock, m.iv, m.candles, m.tick, m.vols);
        break;
      case "account":
        store.account = { cash: m.cash, positions: m.positions, bailoutLeft: m.bailoutLeft, stars: m.stars, lotteryLeft: m.lotteryLeft };
        store.emit("account");
        break;
      case "order": {
        if (!m.ok) { toast(m.error, "warn"); break; }
        const f = m.fill;
        const pnl = f.pnl === null ? "" : ` · 손익 ${f.pnl >= 0 ? "+" : ""}${won(f.pnl)}`;
        toast(
          `${nameOf(f.stock)} ${ACTION_LABEL[f.action]} ${won(f.qty)}주 @ ${won(f.price)}${pnl}${f.slipped ? " (가격 변동됨)" : ""}`,
          f.action === "buy" || f.action === "cover" ? "up" : "down",
        );
        conn.send({ t: "trades" });
        break;
      }
      case "liquidated":
        toast(`${nameOf(m.stock)} ${m.side === "long" ? "롱" : "숏"} ${won(m.qty)}주가 ${won(m.price)}원에 강제 청산되었습니다.`, "warn", 6000);
        conn.send({ t: "trades" });
        break;
      case "bailout":
        if (m.ok) toast(`파산 구제금 ${won(m.amount ?? 0)}원이 지급되었습니다.`, "up");
        else toast(m.error ?? "구제를 받을 수 없습니다.", "warn");
        break;
      case "trades":
        store.trades = m.trades;
        store.emit("trades");
        break;
      case "stats":
        store.stats = m.stats;
        store.emit("stats");
        break;
      case "quests":
        store.quests = m;
        store.emit("quests");
        break;
      case "claim":
        if (m.ok) toast(`미션 보상 ${won(m.amount ?? 0)}원을 받았습니다.`, "up");
        else toast(m.error ?? "보상을 받을 수 없습니다.", "warn");
        break;
      case "reserves":
        store.reserves = m.items;
        store.emit("reserves");
        break;
      case "reserve":
        if (m.ok) { toast("예약 주문을 등록했습니다.", "up"); conn.send({ t: "reserves" }); }
        else toast(m.error, "warn");
        break;
      case "cancelReserve":
        toast(m.ok ? "예약을 취소했습니다." : m.error ?? "취소하지 못했습니다.", m.ok ? "info" : "warn");
        break;
      case "reserveDone": {
        const it = m.item;
        const label = `${nameOf(it.stock)} ${ACTION_LABEL[it.action]} ${won(it.qty)}주`;
        if (it.status === "filled") toast(`예약 체결: ${label} @ ${won(it.fillPrice ?? 0)}`, it.action === "buy" || it.action === "cover" ? "up" : "down", 6000);
        else toast(`예약 ${it.status === "failed" ? "실패" : "취소"}: ${label} — ${it.note}`, "warn", 6000);
        conn.send({ t: "reserves" });
        conn.send({ t: "trades" });
        break;
      }
      case "lottery":
        lottery.onResult(m);
        if (m.ok && m.payout >= RULES.LOTTERY_PRICE * count0(m)) toast(`복권 당첨금 ${won(m.payout)}원`, "up");
        break;
      case "puzzle":
        puzzle.onResult(m);
        if (m.ok && m.view.phase === "over" && m.view.outcome && m.view.outcome.payout >= RULES.PUZZLE_FEED_MIN) toast(`블록 채우기 ${won(m.view.outcome.payout)}원 획득!`, "up", 6000);
        break;
      case "pt":
        job.onResult(m);
        if (m.ok && m.view.phase === "over" && m.view.end && m.view.end.pay > 0) toast(`알바 수입 +${won(m.view.end.pay)}원`, "up", 4000);
        break;
      case "prestige":
        if (m.ok) toast(`프레스티지! 별 ${m.stars}개 · 시작 자금 ${won(m.cash ?? 0)}원으로 초기화되었습니다.`, "up", 6000);
        else toast(m.error ?? "프레스티지를 할 수 없습니다.", "warn");
        conn.send({ t: "trades" });
        break;
      case "lb":
        rank.onLb(m);
        break;
      case "hof":
        rank.onHof(m);
        break;
      case "lbTick":
        rank.onTick();
        break;
      case "feed":
        store.feed = m.items;
        store.emit("feed");
        break;
      case "fill":
        store.feed = [m.item, ...store.feed].slice(0, 50);
        book.addVolume(m.item.stock, m.item.qty);
        chart.addVolume(m.item.stock, m.item.qty);
        store.emit("feed");
        break;
    }
  };
  conn.start();

  return () => {
    clearInterval(timer);
    document.removeEventListener("keydown", onKey);
    root.classList.remove("app-main");
    hideOverlay();
    conn.stop();
    chart.destroy();
    store.conn = null;
    store.reset();
  };
}
