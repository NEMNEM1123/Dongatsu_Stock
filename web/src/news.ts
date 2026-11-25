import type { NewsItem } from "../../shared/protocol";
import { RULES } from "../../shared/rules";
import { getStock } from "../../shared/stocks";
import { el } from "./dom";
import { timeText, won } from "./format";

export interface NewsStrip {
  el: HTMLElement;
  /** 열람권 만료 시각(ms)과 뉴스 목록을 함께 갱신 */
  set: (items: NewsItem[], until: number) => void;
  add: (item: NewsItem) => void;
  /** 구매 요청이 끝났을 때 버튼을 되돌린다 */
  resetBuy: () => void;
}

/**
 * 종목 정보 바 아래의 뉴스 띠. 열람권이 없으면 구매 버튼만 보이고, 있으면 뉴스가 오른쪽에서 왼쪽으로 흘러간다.
 * 구매는 순자산의 일부를 내는 큰 지출이라 버튼을 두 번 눌러야 한다.
 */
export function createNewsStrip(opts: { onBuy: () => void; onTimeout: () => void; cost: () => number }): NewsStrip {
  let items: NewsItem[] = [];
  let until = 0;
  let armed = 0; // 첫 번째 클릭 시각 (두 번째 클릭 대기 중이면 0이 아님)
  let waiting = false;
  const active = (): boolean => until > Date.now();

  const inner = el("div", { class: "news-inner" });
  const track = el("div", { class: "news-track" }, inner);
  const side = el("span", { class: "muted num news-side" });
  const buy = el("button", { class: "btn news-buy", type: "button" });
  const root = el("div", { class: "news-strip panel" }, el("span", { class: "news-tag" }, "뉴스"), track, side, buy);

  function renderButton(): void {
    const cost = opts.cost();
    if (waiting) { buy.textContent = "구매 중…"; buy.disabled = true; return; }
    buy.disabled = false;
    buy.textContent = armed ? `정말 구매 (${won(cost)}원)` : `뉴스 보기 · ${RULES.NEWS_PASS_MIN}분`;
  }

  buy.onclick = () => {
    if (waiting) return;
    if (!armed || Date.now() - armed > 4000) { armed = Date.now(); renderButton(); return; }
    armed = 0;
    waiting = true;
    renderButton();
    opts.onBuy();
    // 서버가 응답하지 않으면 버튼이 잠긴 채 남지 않게 한다
    window.setTimeout(() => {
      if (!waiting) return;
      waiting = false;
      renderButton();
      opts.onTimeout();
    }, 8000);
  };

  function render(): void {
    inner.classList.remove("scroll");
    inner.style.removeProperty("--dur");
    if (!active()) {
      buy.hidden = false;
      side.hidden = true;
      inner.replaceChildren(el("span", { class: "muted" }, `이벤트 뉴스는 열람권이 있을 때만 보여요. 현재 순자산의 ${Math.round(RULES.NEWS_PASS_RATE * 100)}%를 내고 ${RULES.NEWS_PASS_MIN}분 동안 볼 수 있어요.`));
      renderButton();
      return;
    }
    buy.hidden = true;
    side.hidden = false;
    tickRemain();
    inner.replaceChildren(
      ...(items.length === 0
        ? [el("span", { class: "muted" }, "아직 새 뉴스가 없어요. 이벤트가 나오면 여기에 떠요.")]
        : items.map((n) => {
            let name = "";
            try { name = getStock(n.stock).name; } catch { /* 알 수 없는 종목 */ }
            return el("span", { class: "news-item" }, el("span", { class: "muted num" }, timeText(n.ts)), el("b", {}, ` [${name}] `), n.headline);
          })),
    );
    // 폭이 넘치면 흘러가게 한다
    requestAnimationFrame(() => {
      if (inner.scrollWidth > track.clientWidth) {
        inner.style.setProperty("--dur", `${Math.max(20, Math.round(inner.scrollWidth / 60))}s`);
        inner.classList.add("scroll");
      }
    });
  }

  function tickRemain(): void {
    const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    side.textContent = `남은 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // 남은 시간 표시, 만료 처리, 구매 확인 대기 해제
  window.setInterval(() => {
    if (until && !active()) { until = 0; items = []; render(); return; }
    if (active()) tickRemain();
    else if (armed && Date.now() - armed > 4000) { armed = 0; renderButton(); }
    else if (!waiting) renderButton(); // 순자산이 바뀌면 금액도 바뀐다
  }, 1000);

  render();
  return {
    el: root,
    set: (list, u) => { items = [...list].slice(0, 10); until = u; waiting = false; armed = 0; render(); },
    add: (item) => {
      if (!active()) return;
      items = [item, ...items.filter((x) => x.id !== item.id)].slice(0, 10);
      render();
    },
    resetBuy: () => { waiting = false; armed = 0; renderButton(); },
  };
}
