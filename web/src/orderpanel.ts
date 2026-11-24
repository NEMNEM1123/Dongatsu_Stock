import { RULES } from "../../shared/rules";
import { getStock } from "../../shared/stocks";
import type { OrderAction } from "../../shared/protocol";
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
  for (const l of RULES.LEVERAGES) {
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

  const root = el(
    "div",
    { class: "panel orderpanel" },
    tabsEl,
    el("div", { class: "op-body" }, levWrap, el("div", { class: "op-row" }, el("span", { class: "muted" }, "수량"), qty), quick, refEl, table, msg, exec),
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
    if (tab === "buy") return p === 1 ? maxBuyQty(cash, price, leverage) : Math.floor(maxBuyQty(cash, price, leverage) * p);
    if (tab === "short") return p === 1 ? maxShortQty(cash, price) : Math.floor(maxShortQty(cash, price) * p);
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
    if (a === "short") return short(cash, heldShort(), id, q, price);
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

  function cancelArm(): void {
    if (armed !== undefined) { clearTimeout(armed); armed = undefined; }
    update();
  }

  function setTab(t: Tab): void {
    tab = t;
    if (t !== "buy") leverage = 1;
    cancelArm();
    update();
  }

  const labels: Record<OrderAction, string> = { buy: "매수", sell: "매도", short: "공매도", cover: "환매" };

  function update(): void {
    for (const [k, b] of tabBtns) {
      b.setAttribute("aria-selected", String(k === tab));
      setClass(b, `tab tab-${k}`);
    }
    levWrap.hidden = tab !== "buy";
    for (const [l, b] of levBtns) setClass(b, `seg-btn${l === leverage ? " on" : ""}`);
    const a = currentAction();
    setText(tabBtns.get("sell")!, sellAction() === "cover" && tab === "sell" ? "환매" : "매도");
    setClass(exec, `btn btn-lg ${a === "buy" || a === "cover" ? "btn-buy" : "btn-sell"}`);
    if (armed === undefined) setText(exec, `${labels[a]}${a === "buy" || a === "cover" ? "" : ""}`);
    else setText(exec, "한 번 더 눌러 확인");

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
      qty: Math.floor(Number(qty.value)), leverage: tab === "buy" ? leverage : undefined, px: priceNow(),
    });
    update();
  };

  store.on("stock", () => { cancelArm(); });
  store.on("account", update);
  store.on("ref", update);
  update();

  return { el: root, tick: update, setTab };
}
