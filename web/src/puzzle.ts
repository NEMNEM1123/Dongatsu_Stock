import { RULES } from "../../shared/rules";
import { MAX_STAGE, multFor, placedCells, rotate, stageConfig, type PieceDef, type Placement } from "../../shared/puzzle";
import type { ClientMsg, PuzzleView, ServerMsg } from "../../shared/protocol";
import { el } from "./dom";
import { signed, won } from "./format";
import { store } from "./store";

type PuzzleMsg = Extract<ServerMsg, { t: "puzzle" }>;

const REPLY_TIMEOUT_MS = 5000;
const QUICK_BETS = [10_000, 100_000, 500_000, 1_000_000];

/**
 * 블록 채우기 화면. 퍼즐 생성·시간 판정·정답 검사·정산은 전부 서버가 하고,
 * 여기서는 서버가 준 판을 보여 주고 조각을 놓는 조작만 받는다. (타이머도 표시용)
 */
export function createPuzzleView(): {
  el: HTMLElement;
  show: () => void;
  update: () => void;
  onResult: (m: PuzzleMsg) => void;
  reset: () => void;
} {
  let view: PuzzleView | null = null;
  let bet = 100_000;
  let msg = ""; // 안내·오류 한 줄
  let busy = false;
  let busyTimer: number | undefined;

  // 현재 단계의 로컬 상태
  let puzzleKey = "";
  const placed = new Map<number, Placement>();
  const rots = new Map<number, number>();
  let sel: number | null = null;
  let hover: [number, number] | null = null;
  let deadlineAt = 0; // performance.now() 기준 표시용 마감
  let settleAsked = false;

  // play 화면의 요소들
  let cellEls: HTMLElement[] = [];
  let trayEl: HTMLElement | null = null;
  let timerFill: HTMLElement | null = null;
  let timerText: HTMLElement | null = null;
  let msgEl: HTMLElement | null = null;

  const body = el("div", { class: "pz-body" });
  const root = el("div", { class: "panel puzzle-view" }, el("div", { class: "panel-title" }, "블록 채우기"), body);

  const release = (): void => {
    busy = false;
    clearTimeout(busyTimer);
  };

  /** 서버에 보낸다. 연결이 없으면 보내지 않고 안내만 한다. */
  function send(m: ClientMsg): void {
    if (busy) return;
    if (!store.conn?.send(m)) {
      msg = "서버와 연결 중입니다. 잠시 후 다시 눌러 주세요.";
      render();
      return;
    }
    busy = true;
    busyTimer = window.setTimeout(() => {
      release();
      msg = "응답이 없습니다. 잠시 후 다시 시도하세요.";
      store.conn?.send({ t: "puzzle", act: "state" });
      render();
    }, REPLY_TIMEOUT_MS);
    render();
  }

  // ── 조각 놓기 ──
  const pieces = (): PieceDef[] => view?.puzzle?.pieces ?? [];
  const size = (): number => view?.puzzle?.size ?? 0;
  const pieceById = (id: number): PieceDef => pieces().find((p) => p.id === id)!;

  function owners(): number[] {
    const o = new Array<number>(size() * size()).fill(-1);
    for (const pl of placed.values()) {
      for (const [r, c] of placedCells(pieceById(pl.id), pl)) o[r * size() + c] = pl.id;
    }
    return o;
  }

  /** 칸 (r,c)를 조각의 첫 번째 칸(맨 윗줄 왼쪽)에 맞춰 놓는 배치 */
  function anchored(id: number, r: number, c: number): Placement {
    const rot = rots.get(id) ?? 0;
    const first = rotate(pieceById(id).cells, rot)[0]!;
    return { id, rot, x: c - first[1], y: r - first[0] };
  }

  function fits(pl: Placement, occ: number[]): boolean {
    const n = size();
    return placedCells(pieceById(pl.id), pl).every(([r, c]) => r >= 0 && c >= 0 && r < n && c < n && occ[r * n + c] === -1);
  }

  function paintBoard(): void {
    const n = size();
    if (!n || cellEls.length !== n * n) return;
    const occ = owners();
    const ghost = new Map<number, boolean>();
    if (sel !== null && hover) {
      const pl = anchored(sel, hover[0], hover[1]);
      const ok = fits(pl, occ);
      for (const [r, c] of placedCells(pieceById(sel), pl)) if (r >= 0 && c >= 0 && r < n && c < n) ghost.set(r * n + c, ok);
    }
    cellEls.forEach((cell, i) => {
      const o = occ[i]!;
      const g = ghost.get(i);
      cell.className = `pz-cell${o >= 0 ? ` filled pc${o % 8}` : ""}${g === undefined ? "" : g ? " ghost-ok" : " ghost-bad"}`;
    });
  }

  function miniShape(p: PieceDef, rot: number): HTMLElement {
    const shape = rotate(p.cells, rot);
    const h = Math.max(...shape.map((c) => c[0])) + 1;
    const w = Math.max(...shape.map((c) => c[1])) + 1;
    const on = new Set(shape.map((c) => `${c[0]},${c[1]}`));
    const box = el("div", { class: "pz-mini" });
    box.style.gridTemplateColumns = `repeat(${w}, var(--pz-mini))`;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) box.appendChild(el("i", { class: on.has(`${r},${c}`) ? `pc${p.id % 8}` : "gap" }));
    }
    return box;
  }

  function renderTray(): void {
    if (!trayEl) return;
    const rest = pieces().filter((p) => !placed.has(p.id));
    if (rest.length === 0) {
      trayEl.replaceChildren(el("div", { class: "muted" }, "모든 조각을 놓았습니다. 서버가 확인하고 있어요…"));
      return;
    }
    trayEl.replaceChildren(
      ...rest.map((p) => {
        const b = el("button", { class: `pz-piece${sel === p.id ? " on" : ""}`, type: "button", title: "누르면 선택, 한 번 더 누르면 회전" }, miniShape(p, rots.get(p.id) ?? 0));
        b.onclick = () => {
          if (sel === p.id) rotateSel();
          else { sel = p.id; paintBoard(); renderTray(); }
        };
        return b;
      }),
    );
  }

  function rotateSel(): void {
    if (sel === null) return;
    rots.set(sel, ((rots.get(sel) ?? 0) + 1) % 4);
    paintBoard();
    renderTray();
  }

  function setMsg(text: string): void {
    msg = text;
    if (msgEl) msgEl.textContent = text;
  }

  function clickCell(r: number, c: number): void {
    if (busy || !view?.puzzle) return;
    const n = size();
    const occ = owners();
    const here = occ[r * n + c]!;
    if (sel !== null) {
      const pl = anchored(sel, r, c);
      if (fits(pl, occ)) {
        placed.set(sel, pl);
        sel = null;
        setMsg("");
        paintBoard();
        renderTray();
        if (placed.size === pieces().length) send({ t: "puzzle", act: "submit", placements: [...placed.values()] });
        return;
      }
      if (here < 0) { setMsg("그 자리에는 놓을 수 없어요."); return; }
    }
    if (here >= 0) { // 놓인 조각을 다시 집는다
      placed.delete(here);
      sel = here;
      setMsg("");
      paintBoard();
      renderTray();
    }
  }

  // ── 화면 ──
  const stageRows = (): HTMLElement =>
    el(
      "table",
      { class: "grid pz-stages" },
      el("thead", {}, el("tr", {}, el("th", {}, "단계"), el("th", {}, "판"), el("th", { class: "num" }, "제한"), el("th", { class: "num" }, "정산 시 배당"))),
      el(
        "tbody",
        {},
        ...RULES.PUZZLE_STAGES.map((s, i) => {
          const m = multFor(i + 1);
          return el(
            "tr",
            {},
            el("td", {}, `${i + 1}단계`),
            el("td", {}, `${s.size}×${s.size}`),
            el("td", { class: "num" }, `${s.seconds}초`),
            el("td", { class: `num ${m > 1 ? "up" : "down"}` }, `×${m} (${m > 1 ? "+" : "−"}${Math.round(Math.abs(m - 1) * 100)}%)`),
          );
        }),
      ),
    );

  function renderSetup(): void {
    const cash = store.account.cash;
    const maxBet = Math.min(RULES.PUZZLE_MAX_BET, cash);
    if (bet > maxBet && maxBet >= RULES.PUZZLE_MIN_BET) bet = maxBet;
    const input = el("input", { class: "input num", type: "number", min: String(RULES.PUZZLE_MIN_BET), max: String(RULES.PUZZLE_MAX_BET), step: "10000", value: String(bet) });
    const start = el("button", { class: "btn btn-buy btn-lg", type: "button" });
    const sync = (): void => {
      const v = Math.floor(Number(input.value));
      bet = Number.isFinite(v) ? v : 0;
      const bad = bet < RULES.PUZZLE_MIN_BET || bet > RULES.PUZZLE_MAX_BET;
      start.disabled = busy || bad || bet > store.account.cash;
      start.textContent = bad ? `${won(RULES.PUZZLE_MIN_BET)}~${won(RULES.PUZZLE_MAX_BET)}원 사이로 입력하세요` : bet > store.account.cash ? "잔고가 부족합니다" : `${won(bet)}원 걸고 시작`;
    };
    input.oninput = sync;
    start.onclick = () => send({ t: "puzzle", act: "start", bet });
    const quick = el("div", { class: "seg pz-quick" });
    for (const q of QUICK_BETS) {
      const b = el("button", { class: "seg-btn", type: "button" }, q >= 10_000 ? `${won(q / 10_000)}만` : won(q));
      b.onclick = () => { input.value = String(Math.min(q, Math.max(maxBet, RULES.PUZZLE_MIN_BET))); sync(); };
      quick.appendChild(b);
    }
    sync();

    const o = view?.outcome;
    const result = el("div", { class: "pz-result" });
    if (o) {
      const net = o.payout - o.bet;
      if (o.kind === "lost") {
        result.replaceChildren(el("div", { class: "warn-text" }, `시간 초과! ${o.cleared + 1}단계에서 실패해 배팅 ${won(o.bet)}원을 잃었습니다.`));
      } else {
        result.replaceChildren(
          document.createTextNode(`${o.kind === "max" ? "모든 단계 클리어! " : ""}${o.cleared}단계까지 깨서 ${won(o.payout)}원을 받았습니다 `),
          el("span", { class: net > 0 ? "up" : net < 0 ? "down" : "muted" }, `(${signed(net)}원)`),
        );
      }
    }
    body.replaceChildren(
      el("div", { class: "lot-info muted" }, "조각을 모두 써서 판을 빈틈없이 채우세요. 조각은 돌려서 놓을 수 있어요. 제한 시간 안에 못 채우면 건 돈을 잃고, 단계를 깰 때마다 계속할지 정산할지 고를 수 있어요."),
      el("div", { class: "op-row" }, el("span", { class: "muted" }, "보유 현금"), el("span", { class: "num" }, `${won(cash)}원`)),
      el("div", { class: "op-row" }, el("span", { class: "muted" }, "배팅 금액"), input),
      quick,
      start,
      result,
      msg ? el("div", { class: "warn-text" }, msg) : el("div", {}),
      el("div", { class: "lot-prizes" }, el("div", { class: "panel-title" }, "단계표 · 3단계부터 이득"), stageRows()),
    );
    trayEl = timerFill = timerText = msgEl = null;
    cellEls = [];
  }

  function renderChoice(): void {
    const v = view!;
    const next = stageConfig(v.stage + 1);
    const cashNet = v.cashValue - v.bet;
    const nextNet = v.nextValue - v.bet;
    const take = el("button", { class: "btn btn-sell btn-lg", type: "button", disabled: busy }, `정산 받기 · ${won(v.cashValue)}원`);
    take.onclick = () => send({ t: "puzzle", act: "cash" });
    const go = el("button", { class: "btn btn-buy btn-lg", type: "button", disabled: busy }, `${v.stage + 1}단계 도전 (${next.size}×${next.size} · ${next.seconds}초)`);
    go.onclick = () => send({ t: "puzzle", act: "next" });
    body.replaceChildren(
      el("div", { class: "pz-clear" }, `${v.stage}단계 성공!`),
      el("div", { class: "op-row" }, el("span", { class: "muted" }, "배팅"), el("span", { class: "num" }, `${won(v.bet)}원`)),
      el("div", { class: "op-row" }, el("span", { class: "muted" }, "지금 정산하면"), el("span", { class: `num ${cashNet > 0 ? "up" : "down"}` }, `${won(v.cashValue)}원 (${signed(cashNet)}원)`)),
      el("div", { class: "op-row" }, el("span", { class: "muted" }, `${v.stage + 1}단계를 깨면`), el("span", { class: `num ${nextNet > 0 ? "up" : "down"}` }, `${won(v.nextValue)}원 (${signed(nextNet)}원)`)),
      el("div", { class: "warn-text" }, `${v.stage + 1}단계에서 시간 안에 못 깨면 배팅 ${won(v.bet)}원을 전부 잃습니다.`),
      take,
      go,
      msg ? el("div", { class: "warn-text" }, msg) : el("div", {}),
    );
    trayEl = timerFill = timerText = msgEl = null;
    cellEls = [];
  }

  function renderPlay(): void {
    const v = view!;
    const n = size();
    const board = el("div", { class: "pz-board" });
    board.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    board.onpointerleave = () => { hover = null; paintBoard(); };
    cellEls = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = el("div", { class: "pz-cell" });
        cell.onpointerenter = () => { hover = [r, c]; paintBoard(); };
        cell.onclick = () => clickCell(r, c);
        cellEls.push(cell);
        board.appendChild(cell);
      }
    }
    timerFill = el("i");
    timerText = el("span", { class: "num" });
    msgEl = el("div", { class: "warn-text pz-msg" }, msg);
    trayEl = el("div", { class: "pz-tray" });
    const rot = el("button", { class: "btn", type: "button" }, "회전 (R)");
    rot.onclick = rotateSel;
    const reset = el("button", { class: "btn", type: "button" }, "모두 되돌리기");
    reset.onclick = () => { placed.clear(); sel = null; setMsg(""); paintBoard(); renderTray(); };
    body.replaceChildren(
      el(
        "div",
        { class: "pz-head" },
        el("span", {}, `${v.stage}/${MAX_STAGE}단계 · ${n}×${n}`),
        el("span", { class: "muted" }, `배팅 ${won(v.bet)}원`),
        el("span", { class: "spacer" }),
        timerText,
      ),
      el("div", { class: "pz-timer" }, timerFill),
      el("div", { class: "pz-stagewrap" }, board),
      el("div", { class: "pz-tools" }, rot, reset),
      trayEl,
      msgEl,
      el("div", { class: "muted pz-help" }, "조각을 누르고 판의 칸을 누르면 놓여요. 놓은 조각을 누르면 다시 집어요. 한 번 더 누르거나 R 키로 회전해요."),
    );
    paintBoard();
    renderTray();
    tick();
  }

  function render(): void {
    const phase = view?.phase ?? "idle";
    if (phase === "play" && view?.puzzle) renderPlay();
    else if (phase === "choice") renderChoice();
    else renderSetup();
  }

  function tick(): void {
    if (!timerFill || !timerText || view?.phase !== "play") return;
    const total = (view.puzzle?.seconds ?? 1) * 1000;
    const left = Math.max(0, deadlineAt - performance.now());
    timerFill.style.width = `${(left / total) * 100}%`;
    timerFill.className = left < total * 0.25 ? "low" : "";
    timerText.textContent = `${(left / 1000).toFixed(1)}초`;
    if (left <= 0 && !settleAsked) {
      // 표시 시간이 끝났다. 서버의 여유 시간이 지난 뒤 결과를 물어본다.
      settleAsked = true;
      setMsg("시간 초과… 결과를 확인하는 중입니다.");
      window.setTimeout(() => store.conn?.send({ t: "puzzle", act: "state" }), RULES.PUZZLE_GRACE_MS + 400);
    }
  }
  window.setInterval(tick, 100);

  function applyView(v: PuzzleView): void {
    view = v;
    if (v.phase === "play" && v.puzzle) {
      const key = `${v.stage}|${JSON.stringify(v.puzzle.pieces)}`;
      if (key !== puzzleKey) {
        puzzleKey = key;
        placed.clear();
        rots.clear();
        sel = null;
        hover = null;
        settleAsked = false;
      }
      deadlineAt = performance.now() + v.remainMs;
    } else {
      puzzleKey = "";
      placed.clear();
      sel = null;
    }
  }

  document.addEventListener("keydown", (e) => {
    if (store.view !== "puzzle" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key.toLowerCase() === "r") rotateSel();
  });

  // 배팅 금액을 입력하는 중에는 화면을 다시 그리지 않는다 (입력이 끊기지 않게)
  const typing = (): boolean => document.activeElement instanceof HTMLInputElement && body.contains(document.activeElement);
  store.on("account", () => { if ((view?.phase ?? "idle") !== "play" && !typing()) render(); });
  render();

  return {
    el: root,
    show: () => { store.conn?.send({ t: "puzzle", act: "state" }); render(); },
    update: () => { if ((view?.phase ?? "idle") !== "play" && !typing()) render(); },
    /** 연결이 끊기거나 다시 맺어졌을 때: 기다리던 응답은 오지 않으니 서버에 현재 판을 다시 물어본다 */
    reset: () => { release(); store.conn?.send({ t: "puzzle", act: "state" }); },
    onResult: (m) => {
      release();
      if (m.ok) {
        msg = "";
        applyView(m.view);
      } else {
        msg = m.error;
        if (m.view) applyView(m.view);
      }
      render();
    },
  };
}
