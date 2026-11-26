import { RULES } from "../../shared/rules";
import { getStock, leveragesOf } from "../../shared/stocks";
import type { OrderAction } from "../../shared/protocol";
import { describeCondition, isClosing, type ReserveCond } from "../../shared/reserve";
import {
  buy, cover, liquidationPrice, maxBuyQty, maxShortQty, sell, short,
  type OrderResult,
} from "../../shared/trading";
import { el, setClass, setText } from "./dom";
import { signed, won } from "./format";
import { book } from "./pricebook";
import { store } from "./store";

type Tab = "buy" | "sell" | "short";

/** 주문 패널: 매수 / 매도 / 공매도 탭, 레버리지, 수량 빠른 버튼, 예상 표, 실행 버튼 */
export function createOrderPanel(): { el: HTMLElement; tick: () => void; setTab: (t: Tab) => void } {
  let tab: Tab = "buy";
  let leverage = 1;
  let seq = 0;
  let armed: number | undefined; // "한 번 더 눌러 확인" 대기
  let mode: "market" | "reserve" = "market";
  let cond: ReserveCond = "le";
  let presetSig = "";

  const tabBtns = new Map<Tab, HTMLElement>();
  const tabsEl = el("div", { class: "tabs op-tabs" });
  for (const [k, label] of [["buy", "매수"], ["sell", "매도"], ["short", "공매도"]] as [Tab, string][]) {
    const b = el("button", { class: "tab", type: "button" }, label);
    b.onclick = () => setTab(k);
    tabBtns.set(k, b);
    tabsEl.appendChild(b);
  }

  const levWrap = el("div", { class: "op-row" }, el("span", { class: "muted" }, "레버리지"));
  const levBtns = new Map<number, HTMLElement>();
  const levBox = el("div", { class: "seg" });
  for (const l of [...RULES.LEVERAGES, ...RULES.MACHO_LEVERAGES]) {
    const b = el("button", { class: "seg-btn", type: "button" }, `${l}x`);
    b.onclick = () => { leverage = l; cancelArm(); update(); };
    levBtns.set(l, b);
    levBox.appendChild(b);
  }
  levWrap.appendChild(levBox);

  const qty = el("input", { class: "input num", type: "number", min: "1", step: "1", value: "1", inputMode: "numeric" });
  qty.oninput = () => { cancelArm(); update(); };
  const quick = el("div", { class: "op-quick" });
  for (const [label, p] of [["10%", 0.1], ["25%", 0.25], ["50%", 0.5], ["최대", 1]] as [string, number][]) {
    const b = el("button", { class: "btn", type: "button" }, label);
    b.onclick = () => {
      const n = quickQty(p);
      qty.value = String(Math.max(1, n));
      cancelArm();
      update();
    };
    quick.appendChild(b);
  }

  const refEl = el("div", { class: "op-ref muted num" });
  const table = el("div", { class: "op-table" });
  const mkRow = (label: string) => {
    const v = el("span", { class: "num" }, "–");
    table.appendChild(el("div", { class: "op-trow" }, el("span", { class: "muted" }, label), v));
    return v;
  };
  const vAmount = mkRow("예상 금액");
  const vFee = mkRow("수수료");
  const vAfter = mkRow("주문 후 잔고");
  const vLiq = mkRow("예상 청산가");
  const msg = el("div", { class: "op-msg" });
  const exec = el("button", { class: "btn btn-lg", type: "button" }, "매수");

  // ── 예약 주문 (지정가 · 손절 · 익절) ──
  const modeBtns = new Map<"market" | "reserve", HTMLElement>();
  const modeBox = el("div", { class: "seg" });
  for (const [k, label] of [["market", "시장가"], ["reserve", "예약"]] as ["market" | "reserve", string][]) {
    const b = el("button", { class: "seg-btn", type: "button" }, label);
    b.onclick = () => { mode = k; resetTrigger(); cancelArm(); };
    modeBtns.set(k, b);
    modeBox.appendChild(b);
  }
  const modeRow = el("div", { class: "op-row" }, el("span", { class: "muted" }, "주문 방식"), modeBox);

  const condBtns = new Map<ReserveCond, HTMLElement>();
  const condBox = el("div", { class: "seg" });
  for (const [k, label] of [["le", "이하"], ["ge", "이상"]] as [ReserveCond, string][]) {
    const b = el("button", { class: "seg-btn", type: "button" }, label);
    b.onclick = () => { cond = k; update(); };
    condBtns.set(k, b);
    condBox.appendChild(b);
  }
  const trig = el("input", { class: "input num", type: "number", min: String(RULES.PRICE_FLOOR), step: "1", inputMode: "numeric" });
  trig.oninput = () => update();
  const presets = el("div", { class: "op-quick" });
  const resvInfo = el("div", { class: "op-msg muted" });
  const resv = el(
    "div",
    { class: "op-resv" },
    el("div", { class: "op-row" }, el("span", { class: "muted" }, "조건"), condBox),
    el("div", { class: "op-row" }, el("span", { class: "muted" }, "가격"), trig),
    presets,
    resvInfo,
  );

  const root = el(
    "div",
    { class: "panel orderpanel" },
    tabsEl,
    el("div", { class: "op-body" }, modeRow, levWrap, el("div", { class: "op-row" }, el("span", { class: "muted" }, "수량"), qty), quick, refEl, resv, table, msg, exec),
  );

  // ── 계산 ──
  const stockId = () => store.stock;
  const priceNow = () => book.priceNow(stockId());
  const heldLong = () => store.position(stockId(), "long");
  const heldShort = () => store.position(stockId(), "short");
  /** 매도 탭은 롱을 팔고, 롱이 없고 공매도가 있으면 환매한다 */
  const sellAction = (): OrderAction => (!heldLong() && heldShort() ? "cover" : "sell");

  function quickQty(p: number): number {
    const price = priceNow();
    const cash = store.account.cash;
    if (tab === "buy") return p === 1 ? maxBuyQty(cash, price, leverage, stockId()) : Math.floor(maxBuyQty(cash, price, leverage, stockId()) * p);
    if (tab === "short") return p === 1 ? maxShortQty(cash, price, leverage) : Math.floor(maxShortQty(cash, price, leverage) * p);
    const held = (sellAction() === "sell" ? heldLong() : heldShort())?.qty ?? 0;
    return p === 1 ? held : Math.floor(held * p);
  }

  function currentAction(): OrderAction {
    return tab === "buy" ? "buy" : tab === "short" ? "short" : sellAction();
  }

  function simulate(): OrderResult {
    const q = Math.floor(Number(qty.value));
    const price = priceNow();
    const cash = store.account.cash;
    const id = stockId();
    const a = currentAction();
    if (a === "buy") return buy(cash, heldLong(), id, q, price, leverage);
    if (a === "short") return short(cash, heldShort(), id, q, price, leverage);
    if (a === "sell") return sell(cash, heldLong(), q, price);
    return cover(cash, heldShort(), q, price);
  }

  const needsConfirm = (): boolean => {
    const a = currentAction();
    const q = Math.floor(Number(qty.value));
    if (a === "buy") return leverage > 1;
    if (a === "short") return true;
    const pos = a === "sell" ? heldLong() : heldShort();
    return !!pos && q >= pos.qty; // 전량 정리
  };

  /** 조건 가격과 방향의 기본값: 매수·매도는 "이하"(지정가 매수·손절), 공매도·환매는 "이상"(손절) */
  function resetTrigger(): void {
    const a = currentAction();
    cond = a === "short" || a === "cover" ? "ge" : "le";
    if (book.ready) trig.value = String(Math.max(RULES.PRICE_FLOOR, Math.round(priceNow())));
    presetSig = "";
  }

  /** 정리 주문일 때만: 평균가 기준 손절·익절 빠른 입력 */
  function syncPresets(): void {
    const a = currentAction();
    const pos = isClosing(a) ? (a === "sell" ? heldLong() : heldShort()) : undefined;
    const sig = pos ? `${a}:${stockId()}:${pos.cost}:${pos.qty}` : "";
    if (sig === presetSig) return;
    presetSig = sig;
    presets.replaceChildren();
    if (!pos) return;
    const avg = pos.cost / pos.qty;
    const stop = RULES.RESERVE_STOP_PCT, take = RULES.RESERVE_TAKE_PCT;
    const defs: [string, ReserveCond, number][] =
      a === "sell"
        ? [[`손절 -${stop * 100}%`, "le", avg * (1 - stop)], [`익절 +${take * 100}%`, "ge", avg * (1 + take)]]
        : [[`손절 +${stop * 100}%`, "ge", avg * (1 + stop)], [`익절 -${take * 100}%`, "le", avg * (1 - take)]];
    for (const [label, c, price] of defs) {
      const b = el("button", { class: "btn", type: "button" }, label);
      b.onclick = () => { cond = c; trig.value = String(Math.max(RULES.PRICE_FLOOR, Math.round(price))); update(); };
      presets.appendChild(b);
    }
  }

  /** 예약 입력 검사. 문제가 없으면 null */
  function reserveError(): string | null {
    const q = Math.floor(Number(qty.value));
    const t = Math.floor(Number(trig.value));
    if (!Number.isFinite(q) || q < 1) return "수량을 입력하세요.";
    if (!Number.isFinite(t) || t < RULES.PRICE_FLOOR) return `조건 가격은 ${won(RULES.PRICE_FLOOR)}원 이상이어야 합니다.`;
    const a = currentAction();
    if (isClosing(a)) {
      const pos = a === "sell" ? heldLong() : heldShort();
      if (!pos) return a === "sell" ? "보유한 수량이 없습니다." : "공매도 포지션이 없습니다.";
      if (q > pos.qty) return "보유 수량보다 많습니다.";
    }
    if (store.reserves.filter((x) => x.status === "pending").length >= RULES.RESERVE_MAX) return `예약은 최대 ${RULES.RESERVE_MAX}건까지입니다.`;
    return null;
  }

  function cancelArm(): void {
    if (armed !== undefined) { clearTimeout(armed); armed = undefined; }
    update();
  }

  function setTab(t: Tab): void {
    if (t !== tab) leverage = 1; // 매수에서 고른 배율이 공매도로 넘어가지 않게 탭을 바꾸면 1배부터
    tab = t;
    if (t !== "sell" && !leveragesOf(stockId()).includes(leverage)) leverage = leveragesOf(stockId())[0]!;
    resetTrigger();
    cancelArm();
    update();
  }

  const labels: Record<OrderAction, string> = { buy: "매수", sell: "매도", short: "공매도", cover: "환매" };

  function update(): void {
    for (const [k, b] of tabBtns) {
      b.setAttribute("aria-selected", String(k === tab));
      setClass(b, `tab tab-${k}`);
    }
    const macho = getStock(stockId()).kind === "macho";
    // 상남자 종목은 공매도가 없고, 레버리지는 10~50배 중에서만 고른다
    if (macho && tab === "short") tab = "buy";
    const allowed = leveragesOf(stockId());
    if (!allowed.includes(leverage) && tab !== "sell") leverage = allowed[0]!;
    tabBtns.get("short")!.hidden = macho;
    levWrap.hidden = tab === "sell";
    for (const [l, b] of levBtns) { b.hidden = !allowed.includes(l); setClass(b, `seg-btn${l === leverage ? " on" : ""}`); }
    const a = currentAction();
    setText(tabBtns.get("sell")!, sellAction() === "cover" && tab === "sell" ? "환매" : "매도");
    setClass(exec, `btn btn-lg ${a === "buy" || a === "cover" ? "btn-buy" : "btn-sell"}`);
    if (armed === undefined) setText(exec, `${labels[a]}${a === "buy" || a === "cover" ? "" : ""}`);
    else setText(exec, "한 번 더 눌러 확인");

    for (const [k, b] of modeBtns) setClass(b, `seg-btn${k === mode ? " on" : ""}`);
    const reserving = mode === "reserve";
    resv.hidden = !reserving;
    table.hidden = reserving;
    if (reserving) {
      for (const [k, b] of condBtns) setClass(b, `seg-btn${k === cond ? " on" : ""}`);
      syncPresets();
      setClass(exec, `btn btn-lg ${a === "buy" || a === "cover" ? "btn-buy" : "btn-sell"}`);
      setText(exec, "예약 등록");
      const err = reserveError();
      if (err) {
        setText(resvInfo, err);
        setClass(resvInfo, "op-msg warn-text");
      } else {
        const q = Math.floor(Number(qty.value));
        const t = Math.floor(Number(trig.value));
        const now = book.ready ? priceNow() : 0;
        const already = now > 0 && (cond === "le" ? now <= t : now >= t);
        setText(
          resvInfo,
          `가격이 ${describeCondition(cond, t)}이 되면 ${labels[a]} ${won(q)}주${already ? " · 지금 가격이 이미 조건을 만족해 다음 시세 갱신 때 바로 체결됩니다" : ""} (현재 ${won(now)}원)`,
        );
        setClass(resvInfo, "op-msg muted");
      }
      setText(msg, "");
      exec.disabled = !book.ready || err !== null;
      refEl.hidden = true;
      return;
    }

    if (!book.ready) {
      exec.disabled = true;
      return;
    }
    const r = simulate();
    if (r.ok) {
      setText(vAmount, `${won(r.notional)}원`);
      setText(vFee, `${won(r.fee)}원`);
      setText(vAfter, `${won(r.cash)}원`);
      const lp = r.position ? liquidationPrice(r.position) : null;
      setText(vLiq, lp ? `${won(lp)}원` : "–");
      setText(msg, a === "sell" || a === "cover" ? `실현손익 ${signed(r.pnl ?? 0)}원` : "");
      setClass(msg, `op-msg ${(r.pnl ?? 0) > 0 ? "up" : (r.pnl ?? 0) < 0 ? "down" : "muted"}`);
    } else {
      setText(vAmount, "–"); setText(vFee, "–"); setText(vAfter, "–"); setText(vLiq, "–");
      setText(msg, r.error);
      setClass(msg, "op-msg warn-text");
    }
    exec.disabled = !r.ok;
    setText(refEl, store.refPrice ? `참고 가격 ${won(store.refPrice)} (체결은 항상 현재가)` : "");
    refEl.hidden = !store.refPrice;
  }

  exec.onclick = () => {
    if (mode === "reserve") {
      if (reserveError() !== null) return;
      const sent = store.conn?.send({
        t: "reserve", stock: stockId(), action: currentAction(), qty: Math.floor(Number(qty.value)),
        leverage: tab !== "sell" ? leverage : undefined, cond, trigger: Math.floor(Number(trig.value)),
      });
      if (!sent) resvInfo.textContent = "서버와 연결 중입니다. 잠시 후 다시 눌러 주세요.";
      return;
    }
    const r = simulate();
    if (!r.ok || !store.conn) return;
    if (needsConfirm() && armed === undefined) {
      armed = window.setTimeout(() => { armed = undefined; update(); }, 3000);
      update();
      return;
    }
    if (armed !== undefined) { clearTimeout(armed); armed = undefined; }
    store.conn.send({
      t: "order", id: ++seq, stock: stockId(), action: currentAction(),
      qty: Math.floor(Number(qty.value)), leverage: tab !== "sell" ? leverage : undefined, px: priceNow(),
    });
    update();
  };

  store.on("stock", () => { resetTrigger(); cancelArm(); });
  store.on("reserves", update);
  store.on("account", update);
  store.on("ref", update);
  update();

  return { el: root, tick: update, setTab };
}
