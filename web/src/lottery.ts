import { RULES } from "../../shared/rules";
import { expectedPayout, prizeOdds } from "../../shared/lottery";
import type { ServerMsg } from "../../shared/protocol";
import { el } from "./dom";
import { signed, won } from "./format";
import { store } from "./store";

type LotteryMsg = Extract<ServerMsg, { t: "lottery" }>;

/** 즉석 복권 화면. 추첨은 서버가 하고, 여기서는 결과를 보여 주기만 한다. */
export function createLotteryView(): { el: HTMLElement; update: () => void; onResult: (m: LotteryMsg) => void; reset: () => void } {
  const REPLY_TIMEOUT_MS = 5000;
  const kstDay = (): number => Math.floor((Date.now() + 9 * 3_600_000) / 86_400_000);
  let count = 1;
  let busy = false;
  let busyTimer: number | undefined;
  let lastDay = kstDay();

  /** 응답 대기를 끝낸다 (응답 수신, 연결 끊김, 타임아웃 공통) */
  const release = (): void => {
    busy = false;
    clearTimeout(busyTimer);
  };

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
    if (busy) return;
    // 연결이 열려 있지 않으면 보내지 않는다 (예전에는 busy만 켜져 버튼이 영구히 잠겼다)
    if (!store.conn?.send({ t: "lottery", count })) {
      result.replaceChildren(el("div", { class: "warn-text" }, "서버와 연결 중입니다. 잠시 후 다시 눌러 주세요."));
      summary.textContent = "";
      return;
    }
    busy = true;
    // 응답이 끝내 오지 않아도 버튼이 잠긴 채 남지 않게 하고, 실제 결과는 계좌 갱신으로 확인한다
    busyTimer = window.setTimeout(() => {
      release();
      result.replaceChildren(el("div", { class: "warn-text" }, "응답이 없습니다. 잔고를 확인한 뒤 다시 시도하세요."));
      summary.textContent = "";
      store.conn?.send({ t: "account" });
      update();
    }, REPLY_TIMEOUT_MS);
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
    // 남은 장수·현금으로 살 수 있는 만큼으로 장수를 줄인다 (버튼이 이유 없이 꺼지지 않게)
    const affordable = Math.floor(store.account.cash / RULES.LOTTERY_PRICE);
    if (count > left) count = Math.max(1, left);
    if (count > affordable) count = Math.max(1, affordable);
    // 1·5·10장과 값이 같으면 그 버튼만, 아니면 "최대"를 켠다
    const preset = ([1, 5, 10] as const).find((n) => n === count);
    for (const [k, b] of segBtns) b.classList.toggle("on", preset !== undefined ? k === preset : k === "max");
    const cost = count * RULES.LOTTERY_PRICE;
    buy.textContent = `${count}장 구매 (${won(cost)}원)`;
    buy.disabled = busy || left <= 0 || cost > store.account.cash;
    if (left <= 0) buy.textContent = "오늘은 모두 구매했습니다";
    else if (affordable <= 0) buy.textContent = "잔고가 부족합니다";
  }

  // 복권 화면을 열 때와 날짜(KST)가 바뀔 때 계좌를 다시 받아 "남은 장수"를 맞춘다
  const refresh = (): void => { store.conn?.send({ t: "account" }); };
  store.on("view", () => { if (store.view === "lottery") refresh(); });
  window.setInterval(() => {
    const d = kstDay();
    if (d !== lastDay) { lastDay = d; refresh(); }
  }, 30_000);

  store.on("account", update);
  update();

  return {
    el: root,
    update,
    /** 연결이 끊기거나 다시 맺어졌을 때: 기다리던 응답은 오지 않는다 */
    reset: () => { release(); update(); },
    onResult: (m) => {
      release();
      if (!m.ok) {
        result.replaceChildren(el("div", { class: "warn-text" }, m.error));
        summary.textContent = "";
      } else {
        // 곧 이어 오는 account 메시지 전까지 이전 값이 보이지 않게 먼저 반영한다
        store.account = { ...store.account, cash: store.account.cash - m.cost + m.payout, lotteryLeft: m.left };
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
