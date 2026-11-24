import { METRICS, PERIODS, type Metric, type Period } from "../../shared/leaderboard";
import type { HofGroup, LbEntry, ServerMsg } from "../../shared/protocol";
import { el } from "./dom";
import { pct, signed, timeText, won } from "./format";
import { store } from "./store";

type LbMsg = Extract<ServerMsg, { t: "lb" }>;
type HofMsg = Extract<ServerMsg, { t: "hof" }>;
type Mode = Period | "hof";

const PERIOD_LABEL: Record<Period, string> = { live: "실시간", week: "주간", season: "시즌", all: "역대" };
const METRIC_LABEL: Record<Metric, string> = { nw: "순자산", rate: "수익률", honor: "명예 점수" };

/** 값 표시: 기간에 따라 순자산은 '현재 값' 또는 '증감액'이 된다 */
export function formatValue(period: Period | "hof", metric: Metric, v: number): string {
  if (metric === "rate") return pct(v);
  if (metric === "honor") return `${won(Math.floor(v / 1_000_000))}점`;
  return period === "week" || period === "season" ? `${signed(v)}원` : `${won(v)}원`;
}

const metricTitle = (period: Mode, metric: Metric): string => {
  if (metric === "nw" && (period === "week" || period === "season")) return "순자산 증감";
  if (period === "all") return `최고 ${METRIC_LABEL[metric]}`;
  return METRIC_LABEL[metric];
};

/** 순위 화면: 기간·지표 탭, 상위 100위, 내 순위 하단 고정, 명예의 전당 */
export function createRankView(): {
  el: HTMLElement;
  show: () => void;
  onLb: (m: LbMsg) => void;
  onHof: (m: HofMsg) => void;
  onTick: () => void;
} {
  let mode: Mode = "live";
  let metric: Metric = "nw";
  let visible = false;
  let lastLb: LbMsg | null = null;

  const periodTabs = el("div", { class: "tabs" });
  const modeBtns = new Map<Mode, HTMLElement>();
  for (const p of [...PERIODS, "hof" as const]) {
    const b = el("button", { class: "tab", type: "button" }, p === "hof" ? "명예의 전당" : PERIOD_LABEL[p]);
    b.onclick = () => { mode = p; request(); render(); };
    modeBtns.set(p, b);
    periodTabs.appendChild(b);
  }
  const metricBox = el("div", { class: "seg rank-metrics" });
  const metricBtns = new Map<Metric, HTMLElement>();
  for (const m of METRICS) {
    const b = el("button", { class: "seg-btn", type: "button" }, METRIC_LABEL[m]);
    b.onclick = () => { metric = m; request(); render(); };
    metricBtns.set(m, b);
    metricBox.appendChild(b);
  }
  const info = el("div", { class: "rank-info muted" });
  const head = el("div", { class: "rank-head" }, periodTabs, el("div", { class: "spacer" }), metricBox);
  const infoBar = el("div", { class: "rank-infobar" }, info);
  const tbody = el("tbody");
  const valueHead = el("th", { class: "num" }, "순자산");
  const table = el(
    "table",
    { class: "grid rank-table" },
    el("thead", {}, el("tr", {}, el("th", { class: "r-rank" }, "순위"), el("th", {}, "닉네임"), valueHead)),
    tbody,
  );
  const scroll = el("div", { class: "rank-scroll" }, table);
  const hofBox = el("div", { class: "rank-scroll hof" });
  const mine = el("div", { class: "rank-me" });
  const root = el("div", { class: "panel rank-view" }, head, infoBar, scroll, hofBox, mine);
  root.hidden = true;

  function request(): void {
    if (!visible || !store.conn) return;
    if (mode === "hof") store.conn.send({ t: "hof" });
    else store.conn.send({ t: "lb", period: mode, metric });
  }

  const rankCell = (e: LbEntry): HTMLElement => {
    const cell = el("td", { class: `r-rank num r${e.rank <= 3 ? e.rank : ""}` });
    cell.appendChild(el("span", { class: "r-no" }, String(e.rank)));
    let delta: HTMLElement;
    if (e.prev === null) delta = el("span", { class: "r-new" }, "NEW");
    else if (e.prev > e.rank) delta = el("span", { class: "up" }, `▲${e.prev - e.rank}`);
    else if (e.prev < e.rank) delta = el("span", { class: "down" }, `▼${e.rank - e.prev}`);
    else delta = el("span", { class: "muted" }, "–");
    delta.classList.add("r-delta");
    cell.appendChild(delta);
    return cell;
  };

  const nameCell = (nick: string, stars: number): HTMLElement => {
    const td = el("td", { class: "r-nick" }, nick);
    if (stars > 0) td.appendChild(el("span", { class: "r-star" }, ` ★${stars}`));
    return td;
  };

  function renderLb(m: LbMsg): void {
    valueHead.textContent = metricTitle(m.period, m.metric);
    if (m.period === "season" && !m.season) {
      info.textContent = "진행 중인 시즌이 없습니다. 시즌이 시작되면 이곳에 순위가 표시됩니다.";
    } else {
      const parts: string[] = [];
      if (m.season && m.period === "season") parts.push(`시즌: ${m.season.name}`);
      if (m.period === "week") parts.push("월요일 0시(한국 시간)에 초기화");
      if (m.period === "all") parts.push("개인 최고 기록");
      parts.push(m.at ? `집계 ${timeText(m.at)}` : "집계 대기 중");
      parts.push(`${won(m.total)}명`);
      info.textContent = parts.join(" · ");
    }
    if (!m.entries.length) {
      tbody.replaceChildren(el("tr", {}, el("td", { class: "muted empty", colSpan: 3 }, m.period === "season" && !m.season ? "" : "아직 순위가 없습니다. 거래를 시작하면 순위에 오릅니다.")));
    } else {
      tbody.replaceChildren(
        ...m.entries.map((e) =>
          el(
            "tr",
            { class: e.me ? "me" : "" },
            rankCell(e),
            nameCell(e.nick, e.stars),
            el("td", { class: `num ${m.metric === "nw" && m.period !== "live" && m.period !== "all" ? (e.value >= 0 ? "up" : "down") : m.metric === "rate" ? (e.value >= 0 ? "up" : "down") : ""}` }, formatValue(m.period, m.metric, e.value)),
          ),
        ),
      );
    }
    // 내 순위는 목록과 상관없이 아래에 고정
    if (m.me) {
      mine.replaceChildren(
        el("span", { class: "muted" }, "내 순위"),
        el("span", { class: "r-no num" }, `${m.me.rank}위`),
        el("span", { class: "r-nick" }, m.me.nick + (m.me.stars ? ` ★${m.me.stars}` : "")),
        el("span", { class: "spacer" }),
        el("span", { class: "num" }, formatValue(m.period, m.metric, m.me.value)),
      );
    } else {
      mine.replaceChildren(el("span", { class: "muted" }, m.period === "season" && !m.season ? "" : "거래를 시작하면 순위에 오릅니다."));
    }
  }

  function hofTable(g: HofGroup): HTMLElement {
    const rows = g.top[metric].slice(0, 10).map((r) =>
      el("tr", {}, el("td", { class: "r-rank num" }, String(r.rank)), nameCell(r.nick, r.stars), el("td", { class: "num" }, formatValue("hof", metric, r.value))),
    );
    const date = new Date(g.endedAt + 9 * 3600 * 1000).toISOString().slice(0, 10);
    return el(
      "div",
      { class: "hof-group" },
      el("div", { class: "hof-title" }, g.label, el("small", { class: "muted" }, `  종료 ${date} · ${metricTitle("hof", metric)}`)),
      el("table", { class: "grid" }, el("tbody", {}, ...rows)),
    );
  }

  function renderHof(m: HofMsg): void {
    const blocks: Node[] = [];
    if (m.seasons.length) blocks.push(el("div", { class: "hof-sec" }, "시즌"), ...m.seasons.map(hofTable));
    if (m.weeks.length) blocks.push(el("div", { class: "hof-sec" }, "최근 주간"), ...m.weeks.map(hofTable));
    if (!blocks.length) blocks.push(el("div", { class: "muted empty" }, "아직 종료된 시즌이나 주간 기록이 없습니다."));
    hofBox.replaceChildren(...blocks);
  }
  let lastHof: HofMsg | null = null;

  function render(): void {
    for (const [k, b] of modeBtns) b.setAttribute("aria-selected", String(k === mode));
    for (const [k, b] of metricBtns) b.classList.toggle("on", k === metric);
    const isHof = mode === "hof";
    scroll.hidden = isHof;
    hofBox.hidden = !isHof;
    mine.hidden = isHof;
    infoBar.hidden = isHof;
    if (isHof) { if (lastHof) renderHof(lastHof); }
    else if (lastLb && lastLb.period === mode && lastLb.metric === metric) renderLb(lastLb);
  }

  render();
  return {
    el: root,
    show: () => {
      visible = true;
      root.hidden = false;
      request();
      render();
    },
    onLb: (m) => {
      if (m.period !== mode || m.metric !== metric) return; // 늦게 온 응답은 무시
      lastLb = m;
      renderLb(m);
    },
    onHof: (m) => {
      lastHof = m;
      if (mode === "hof") renderHof(m);
    },
    onTick: () => { if (visible && mode !== "hof") request(); },
  };
}
