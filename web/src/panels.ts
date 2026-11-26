// 하단 탭에 들어가는 패널: 예약 주문 · 내 성적 · 미션/업적

import { RULES } from "../../shared/rules";
import { getStock } from "../../shared/stocks";
import type { ReserveItem } from "../../shared/reserve";
import { describeCondition } from "../../shared/reserve";
import { el } from "./dom";
import { pct, signed, timeText, tone, won } from "./format";
import { store } from "./store";

const ACTION: Record<string, string> = { buy: "매수", sell: "매도", short: "공매도", cover: "환매" };
const nameOf = (id: number): string => {
  try { return getStock(id).name; } catch { return String(id); }
};

export interface Panel {
  el: HTMLElement;
  /** 탭을 열 때 서버에 데이터를 요청한다 */
  open: () => void;
  render: () => void;
}

// ── 예약 주문 ──
export function createReservePanel(): Panel {
  const root = el("div", { class: "bt-scroll panel-list" });

  const statusText = (r: ReserveItem): string =>
    r.status === "pending" ? "대기 중"
    : r.status === "filled" ? `체결 @ ${won(r.fillPrice ?? 0)}`
    : r.status === "failed" ? `실패 · ${r.note}`
    : `취소 · ${r.note}`;

  function render(): void {
    if (store.reserves.length === 0) {
      root.replaceChildren(el("div", { class: "muted empty" }, "예약 주문이 없습니다. 주문 패널에서 '예약'을 선택해 지정가·손절·익절을 걸 수 있습니다."));
      return;
    }
    root.replaceChildren(
      ...store.reserves.map((r) => {
        const cancel = el("button", { class: "btn bt-act", type: "button" }, "취소");
        cancel.onclick = () => store.conn?.send({ t: "cancelReserve", id: r.id });
        return el(
          "div",
          { class: `resv-row${r.status === "pending" ? "" : " done"}` },
          el("span", { class: "muted num" }, timeText(r.ts)),
          el("span", {}, `${nameOf(r.stock)} · ${describeCondition(r.cond, r.trigger)} → `),
          el("span", { class: r.action === "buy" || r.action === "cover" ? "up" : "down" }, `${ACTION[r.action]}${r.leverage > 1 ? ` ${r.leverage}x` : ""} ${won(r.qty)}주`),
          el("span", { class: r.status === "filled" ? "up" : r.status === "pending" ? "" : "muted" }, ` · ${statusText(r)}`),
          ...(r.status === "pending" ? [el("span", { class: "spacer" }), cancel] : []),
        );
      }),
    );
  }

  store.on("reserves", render);
  render();
  return { el: root, open: () => store.conn?.send({ t: "reserves" }), render };
}

// ── 내 성적 ──
export function createStatsPanel(): Panel {
  const root = el("div", { class: "bt-scroll panel-list" });

  const card = (label: string, value: string, cls = ""): HTMLElement =>
    el("div", { class: "stat-card" }, el("div", { class: "muted" }, label), el("div", { class: `num stat-val ${cls}` }, value));

  function render(): void {
    const s = store.stats;
    if (!s) {
      root.replaceChildren(el("div", { class: "muted empty" }, "불러오는 중입니다…"));
      return;
    }
    const winRate = s.closed > 0 ? s.wins / s.closed : 0;
    const lotNet = s.lottery.payout - s.lottery.cost;
    const cards = el(
      "div",
      { class: "stat-grid" },
      card("총 거래", `${won(s.trades)}회`),
      card("승률", s.closed > 0 ? `${(winRate * 100).toFixed(1)}% (${s.wins}승 ${s.losses}패)` : "–"),
      card("누적 실현손익", `${signed(s.realized)}원`, tone(s.realized)),
      card("낸 수수료", `${won(s.fees)}원`),
      card("최고 거래", s.best ? `${nameOf(s.best.stock)} ${signed(s.best.pnl)}원` : "–", s.best ? tone(s.best.pnl) : ""),
      card("최악 거래", s.worst ? `${nameOf(s.worst.stock)} ${signed(s.worst.pnl)}원` : "–", s.worst ? tone(s.worst.pnl) : ""),
      card("강제 청산", `${s.liquidations}회`),
      card("복권 손익", s.lottery.tickets > 0 ? `${signed(lotNet)}원 (${won(s.lottery.tickets)}장)` : "–", s.lottery.tickets > 0 ? tone(lotNet) : ""),
    );
    const rows = s.byStock.map((x) =>
      el(
        "tr",
        {},
        el("td", {}, nameOf(x.stock)),
        el("td", { class: "num" }, `${x.closed}회`),
        el("td", { class: "num" }, x.closed > 0 ? pct(x.wins / x.closed) : "–"),
        el("td", { class: `num ${tone(x.pnl)}` }, signed(x.pnl)),
      ),
    );
    const table =
      rows.length === 0
        ? el("div", { class: "muted empty" }, "아직 정리한 거래가 없습니다.")
        : el(
            "table",
            { class: "grid" },
            el("thead", {}, el("tr", {}, el("th", {}, "종목"), el("th", { class: "num" }, "정리"), el("th", { class: "num" }, "승률"), el("th", { class: "num" }, "실현손익"))),
            el("tbody", {}, ...rows),
          );
    root.replaceChildren(cards, el("div", { class: "panel-title" }, "종목별 성적"), table);
  }

  store.on("stats", render);
  render();
  return { el: root, open: () => store.conn?.send({ t: "stats" }), render };
}

// ── 미션 · 업적 ──
export function createQuestPanel(): Panel {
  const root = el("div", { class: "bt-scroll panel-list" });

  const bar = (progress: number, target: number): HTMLElement => {
    const fill = el("div", { class: "bar-fill" });
    fill.style.width = `${Math.min(100, (progress / target) * 100)}%`;
    return el("div", { class: "bar" }, fill);
  };
  /** 거래대금처럼 큰 숫자는 원 단위로, 나머지는 그대로 */
  const num = (n: number): string => won(n);

  const openCats = new Set<string>();

  function render(): void {
    const q = store.quests;
    if (!q) {
      root.replaceChildren(el("div", { class: "muted empty" }, "불러오는 중입니다…"));
      return;
    }
    const missions = q.missions.map((m) => {
      const ready = m.progress >= m.target && !m.claimed;
      const btn = el("button", { class: `btn bt-act${ready ? " btn-buy" : ""}`, type: "button" }, m.claimed ? "수령 완료" : `${won(m.reward)}원 받기`);
      btn.disabled = !ready;
      btn.onclick = () => store.conn?.send({ t: "claim", id: m.id });
      return el(
        "div",
        { class: `quest-row${m.claimed ? " done" : ""}` },
        el("div", { class: "quest-main" }, el("div", {}, m.title), el("div", { class: "muted num" }, `${num(m.progress)} / ${num(m.target)}`), bar(m.progress, m.target)),
        btn,
      );
    });
    const badge = (a: (typeof q.achievements)[number]): HTMLElement =>
      el(
        "div",
        { class: `badge${a.done ? " on" : ""}`, title: a.desc },
        el("div", { class: "badge-title" }, `${a.done ? "★ " : ""}${a.title}`),
        el("div", { class: "muted badge-desc" }, a.desc),
        ...(a.done ? [] : [el("div", { class: "muted num badge-desc" }, `${num(a.progress)} / ${num(a.target)}`), bar(a.progress, a.target)]),
      );
    // 100개라서 분류별로 접어 둔다. 갱신해도 펼쳐 둔 분류는 유지한다.
    const groups = RULES.ACHIEVEMENT_CATEGORIES.map((c) => {
      const list = q.achievements.filter((a) => a.cat === c.id);
      const box = el(
        "details",
        { class: "badge-group" },
        el("summary", {}, `${c.name} ${list.filter((a) => a.done).length} / ${list.length}`),
        el("div", { class: "badge-grid" }, ...list.map(badge)),
      );
      box.open = openCats.has(c.id);
      box.ontoggle = () => { if (box.open) openCats.add(c.id); else openCats.delete(c.id); };
      return box;
    });
    root.replaceChildren(
      el("div", { class: "panel-title" }, `오늘의 미션 (매일 0시 갱신 · 소액 거래는 ${won(RULES.MISSION_MIN_NOTIONAL)}원 이상만 인정)`),
      ...missions,
      el("div", { class: "panel-title" }, `업적 ${q.achievements.filter((a) => a.done).length} / ${q.achievements.length}`),
      ...groups,
    );
  }

  store.on("quests", render);
  render();
  return { el: root, open: () => store.conn?.send({ t: "quests" }), render };
}
