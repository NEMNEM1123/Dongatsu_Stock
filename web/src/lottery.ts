import { RULES } from "../../shared/rules";
import { expectedPayout, prizeOdds } from "../../shared/lottery";
import type { ServerMsg } from "../../shared/protocol";
import { el } from "./dom";
import { signed, won } from "./format";
import { store } from "./store";

type LotteryMsg = Extract<ServerMsg, { t: "lottery" }>;

/** 즉석 복권 화면. 추첨은 서버가 하고, 여기서는 결과를 보여 주기만 한다. */
export function createLotteryView(): { el: HTMLElement; update: () => void; onResult: (m: LotteryMsg) => void } {
  let count = 1;
  let busy = false;

  const info = el("div", { class: "lot-info muted" });
  const cashEl = el("span", { class: "num" });
  const seg = el("div", { class: "seg lot-seg" });
  const segBtns = new Map<number | "max", HTMLElement>();
  for (const c of [1, 5, 10, "max"] as const) {
    const b = el("button", { class: "seg-btn", type: "button" }, c === "max" ? "최대" : `${c}장`);
    b.onclick = () => { count = c === "max" ? maxCount() : c; update(); };
    segBtns.set(c, b);
    seg.appendChild(b);
  }
  const buy = el("button", { class: "btn btn-buy btn-lg", type: "button" }, "구매");
  buy.onclick = () => {
    if (busy || !store.conn) return;
    busy = true;
    store.conn.send({ t: "lottery", count });
    update();
  };
  const result = el("div", { class: "lot-result" });
  const summary = el("div", { class: "lot-summary num" });

  const prizeRows = RULES.LOTTERY_PRIZES.map((p) =>
    el("tr", {}, el("td", { class: "num" }, p.payout === 0 ? "꽝" : `${won(p.payout)}원`), el("td", { class: "num muted" }, `${prizeOdds(p.weight).toFixed(2)}%`)),
  );
  const rtp = ((expectedPayout() / RULES.LOTTERY_PRICE) * 100).toFixed(1);
  const prizeTable = el(
    "div",
    { class: "lot-prizes" },
    el("div", { class: "panel-title" }, `상금표 · 기대 환급률 ${rtp}%`),
    el("table", { class: "grid" }, el("thead", {}, el("tr", {}, el("th", {}, "상금"), el("th", { class: "num" }, "확률"))), el("tbody", {}, ...prizeRows)),
  );

  const root = el(
    "div",
    { class: "panel lottery-view" },
    el("div", { class: "panel-title" }, "즉석 복권"),
    el(
      "div",
      { class: "lot-body" },
      info,
      el("div", { class: "op-row" }, el("span", { class: "muted" }, "보유 현금"), cashEl),
      seg,
      buy,
      summary,
      result,
      prizeTable,
    ),
  );

  const maxCount = (): number => {
    const byCash = Math.floor(store.account.cash / RULES.LOTTERY_PRICE);
    return Math.max(1, Math.min(store.account.lotteryLeft, byCash, RULES.LOTTERY_PER_DAY));
  };

  function update(): void {
    const left = store.account.lotteryLeft;
    info.textContent = `1장 ${won(RULES.LOTTERY_PRICE)}원 · 오늘 남은 ${left}장 (하루 ${RULES.LOTTERY_PER_DAY}장) · 결과는 서버가 추첨합니다`;
    cashEl.textContent = `${won(store.account.cash)}원`;
    if (count > left) count = Math.max(1, left);
    // 1·5·10장과 값이 같으면 그 버튼만, 아니면 "최대"를 켠다
    const preset = ([1, 5, 10] as const).find((n) => n === count);
    for (const [k, b] of segBtns) b.classList.toggle("on", preset !== undefined ? k === preset : k === "max");
    const cost = count * RULES.LOTTERY_PRICE;
    buy.textContent = `${count}장 구매 (${won(cost)}원)`;
    buy.disabled = busy || left <= 0 || cost > store.account.cash;
    if (left <= 0) buy.textContent = "오늘은 모두 구매했습니다";
  }

  store.on("account", update);
  update();

  return {
    el: root,
    update,
    onResult: (m) => {
      busy = false;
      if (!m.ok) {
        result.replaceChildren(el("div", { class: "warn-text" }, m.error));
        summary.textContent = "";
      } else {
        result.replaceChildren(
          ...m.payouts.map((p) => el("div", { class: `lot-ticket num ${p > 0 ? (p >= RULES.LOTTERY_PRICE ? "win" : "small") : "lose"}` }, p === 0 ? "꽝" : `${won(p)}원`)),
        );
        const net = m.payout - m.cost;
        summary.replaceChildren(
          document.createTextNode(`구매 ${won(m.cost)}원 → 당첨 ${won(m.payout)}원 `),
          el("span", { class: net > 0 ? "up" : net < 0 ? "down" : "muted" }, `(${signed(net)}원)`),
        );
      }
      update();
    },
  };
}
