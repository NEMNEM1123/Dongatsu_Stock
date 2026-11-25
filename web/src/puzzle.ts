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
    // 5초가 지나도 오류로 보지 않는다: 느린 네트워크에서는 서버가 처리한 뒤 응답이 늦게 도착할 수 있고, 그 응답도 그대로 반영한다.
    busyTimer = window.setTimeout(() => {
      msg = "서버 응답이 늦어지고 있어요. 잠시만 기다려 주세요…";
      render();
      busyTimer = window.setTimeout(() => {
        release();
        msg = "응답이 없습니다. 현재 판 상태를 다시 확인합니다.";
        store.conn?.send({ t: "puzzle", act: "state" }); // 서버에 이미 반영됐다면 이 응답으로 판이 이어진다
        render();
      }, REPLY_TIMEOUT_MS * 5);
    }, REPLY_TIMEOUT_MS);
    render();
  }

  // ── 조각 놓기: 끌어서 놓기 ──
  // 조각을 누른 채 움직이면 조각이 손가락(마우스)을 따라 움직이고, 놓는 자리에 맞춰 칸이 미리 표시된다.
  // 조각을 톡 누르면 회전. 끄는 중에는 R 키·마우스 휠·오른쪽 클릭·다른 손가락으로 톡 누르기로 회전한다.
  const pieces = (): PieceDef[] => view?.puzzle?.pieces ?? [];
  const size = (): number => view?.puzzle?.size ?? 0;
  const pieceById = (id: number): PieceDef => pieces().find((p) => p.id === id)!;
  const TOUCH_LIFT = 28; // 터치로 끌 때 손가락에 가려지지 않도록 조각을 손가락 위로 띄우는 간격(px)
  const TAP_SLOP = 6; // 이만큼 이하로 움직이면 '끌기'가 아니라 '톡 누르기'로 본다(px)

  interface Metrics { left: number; top: number; stride: number; cell: number }
  interface Drag {
    id: number;
    pointerId: number;
    touch: boolean;
    origin: Placement | null; // 판에서 집어 든 조각이면 원래 자리
    srcEl: HTMLElement | null; // 트레이에서 집어 든 조각의 요소
    startX: number;
    startY: number;
    px: number;
    py: number;
    moved: boolean;
    box: HTMLElement;
    cols: number;
    rows: number;
  }
  let drag: Drag | null = null;
  let ghost: { id: number; r: number; c: number } | null = null;

  function owners(): number[] {
    const o = new Array<number>(size() * size()).fill(-1);
    for (const pl of placed.values()) {
      for (const [r, c] of placedCells(pieceById(pl.id), pl)) o[r * size() + c] = pl.id;
    }
    return o;
  }

  function fits(pl: Placement, occ: number[]): boolean {
    const n = size();
    return placedCells(pieceById(pl.id), pl).every(([r, c]) => r >= 0 && c >= 0 && r < n && c < n && occ[r * n + c] === -1);
  }

  /** 회전한 조각의 왼쪽 위 모서리를 (r,c)칸에 맞춘 배치 */
  const boxAt = (id: number, r: number, c: number): Placement => ({ id, rot: rots.get(id) ?? 0, x: c, y: r });

  function paintBoard(): void {
    const n = size();
    if (!n || cellEls.length !== n * n) return;
    const occ = owners();
    const mark = new Map<number, boolean>();
    if (ghost) {
      const pl = boxAt(ghost.id, ghost.r, ghost.c);
      const ok = fits(pl, occ);
      for (const [r, c] of placedCells(pieceById(ghost.id), pl)) if (r >= 0 && c >= 0 && r < n && c < n) mark.set(r * n + c, ok);
    }
    cellEls.forEach((cell, i) => {
      const o = occ[i]!;
      const g = mark.get(i);
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
        const b = el("button", { class: "pz-piece", type: "button", title: "끌어서 놓기 · 톡 누르면 회전" }, miniShape(p, rots.get(p.id) ?? 0));
        b.onpointerdown = (e) => startDrag(e, p.id, null, b);
        b.oncontextmenu = (e) => e.preventDefault();
        return b;
      }),
    );
  }

  function setMsg(text: string): void {
    msg = text;
    if (msgEl) msgEl.textContent = text;
  }

  function metrics(): Metrics | null {
    if (cellEls.length < 2) return null;
    const a = cellEls[0]!.getBoundingClientRect();
    const b = cellEls[1]!.getBoundingClientRect();
    return { left: a.left, top: a.top, stride: b.left - a.left, cell: a.width };
  }

  /** 끌고 다니는 조각: 판의 칸과 같은 크기로 그려서 놓일 모습 그대로 보이게 한다 */
  function floatShape(id: number, m: Metrics): { box: HTMLElement; cols: number; rows: number } {
    const shape = rotate(pieceById(id).cells, rots.get(id) ?? 0);
    const rows = Math.max(...shape.map((c) => c[0])) + 1;
    const cols = Math.max(...shape.map((c) => c[1])) + 1;
    const on = new Set(shape.map((c) => `${c[0]},${c[1]}`));
    const box = el("div", { class: "pz-float" });
    box.style.gridTemplateColumns = `repeat(${cols}, ${m.cell}px)`;
    box.style.gridAutoRows = `${m.cell}px`;
    box.style.gap = `${m.stride - m.cell}px`;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) box.appendChild(el("i", { class: on.has(`${r},${c}`) ? `pc${id % 8}` : "gap" }));
    }
    return { box, cols, rows };
  }

  /** 조각을 손가락 위치로 옮기고, 놓일 칸을 미리 표시한다 */
  function moveDrag(): void {
    const d = drag;
    const m = metrics();
    if (!d || !m) return;
    const w = d.cols * m.stride - (m.stride - m.cell);
    const h = d.rows * m.stride - (m.stride - m.cell);
    const left = d.px - w / 2;
    const top = d.touch ? d.py - h - TOUCH_LIFT : d.py - h / 2;
    d.box.style.transform = `translate(${left}px, ${top}px)`;
    // 조각의 왼쪽 위 모서리에서 가장 가까운 칸에 붙인다
    ghost = { id: d.id, c: Math.round((left - m.left) / m.stride), r: Math.round((top - m.top) / m.stride) };
    paintBoard();
  }

  function rotateDrag(): void {
    const d = drag;
    const m = metrics();
    if (!d || !m) return;
    rots.set(d.id, ((rots.get(d.id) ?? 0) + 1) % 4);
    const f = floatShape(d.id, m);
    d.box.replaceWith(f.box);
    d.box = f.box;
    d.cols = f.cols;
    d.rows = f.rows;
    moveDrag();
  }

  const onDragMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.px = e.clientX;
    drag.py = e.clientY;
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > TAP_SLOP) drag.moved = true;
    if (drag.moved) moveDrag();
  };
  const onDragUp = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.pointerId) endDrag(e.type === "pointerup");
  };
  const onExtraPointer = (e: PointerEvent): void => {
    if (drag && e.pointerId !== drag.pointerId) { e.preventDefault(); rotateDrag(); } // 다른 손가락으로 톡: 회전
  };
  const onWheel = (e: WheelEvent): void => {
    if (!drag) return;
    e.preventDefault();
    rotateDrag();
  };
  const onCtx = (e: Event): void => { if (drag) { e.preventDefault(); rotateDrag(); } };

  function startDrag(e: PointerEvent, id: number, origin: Placement | null, srcEl: HTMLElement | null): void {
    if (drag || busy || !view?.puzzle || (e.pointerType === "mouse" && e.button === 2)) return;
    const m = metrics();
    if (!m) return;
    e.preventDefault();
    if (origin) placed.delete(id); // 판에서 집어 들었으면 일단 비운다
    const f = floatShape(id, m);
    document.body.appendChild(f.box);
    srcEl?.classList.add("drag");
    drag = { id, pointerId: e.pointerId, touch: e.pointerType !== "mouse", origin, srcEl, startX: e.clientX, startY: e.clientY, px: e.clientX, py: e.clientY, moved: false, box: f.box, cols: f.cols, rows: f.rows };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
    window.addEventListener("pointercancel", onDragUp);
    window.addEventListener("pointerdown", onExtraPointer, { passive: false });
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("contextmenu", onCtx);
    moveDrag(); // 집은 순간부터 조각이 손가락 위치에 보이게 한다
  }

  function endDrag(drop: boolean): void {
    const d = drag;
    if (!d) return;
    drag = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
    window.removeEventListener("pointercancel", onDragUp);
    window.removeEventListener("pointerdown", onExtraPointer);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("contextmenu", onCtx);
    d.box.remove();
    const g = ghost;
    ghost = null;

    if (!d.moved) { // 톡 눌렀다: 트레이 조각은 회전, 판 위 조각은 제자리로
      if (d.origin) placed.set(d.id, d.origin);
      else rots.set(d.id, ((rots.get(d.id) ?? 0) + 1) % 4);
      paintBoard();
      renderTray();
      return;
    }
    if (drop && g) {
      const pl = boxAt(d.id, g.r, g.c);
      if (fits(pl, owners())) {
        placed.set(d.id, pl);
        setMsg("");
        paintBoard();
        renderTray();
        if (placed.size === pieces().length) send({ t: "puzzle", act: "submit", placements: [...placed.values()] });
        return;
      }
      if (g.r >= -1 && g.c >= -1 && g.r < size() && g.c < size()) setMsg("그 자리에는 놓을 수 없어요.");
    }
    paintBoard();
    renderTray(); // 놓지 못한 조각은 트레이로 돌아간다
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
    cellEls = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = el("div", { class: "pz-cell" });
        cell.onpointerdown = (e) => {
          const id = owners()[r * n + c]!;
          if (id >= 0) startDrag(e, id, placed.get(id)!, null);
        };
        cellEls.push(cell);
        board.appendChild(cell);
      }
    }
    timerFill = el("i");
    timerText = el("span", { class: "num" });
    msgEl = el("div", { class: "warn-text pz-msg" }, msg);
    trayEl = el("div", { class: "pz-tray" });
    const reset = el("button", { class: "btn", type: "button" }, "모두 되돌리기");
    reset.onclick = () => { placed.clear(); setMsg(""); paintBoard(); renderTray(); };
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
      el("div", { class: "pz-tools" }, reset),
      trayEl,
      msgEl,
      el("div", { class: "muted pz-help" }, "조각을 끌어서 판에 놓으세요. 조각을 톡 누르면 회전해요. 끄는 중에는 다른 손가락으로 화면을 톡 누르거나(마우스는 R 키·오른쪽 클릭) 회전할 수 있어요. 놓은 조각도 다시 끌어서 옮길 수 있어요."),
    );
    paintBoard();
    renderTray();
    tick();
  }

  function render(): void {
    if (drag) endDrag(false); // 끄는 도중 화면이 바뀌면 조각을 트레이로 돌려놓는다
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
        settleAsked = false;
      }
      deadlineAt = performance.now() + v.remainMs;
    } else {
      puzzleKey = "";
      placed.clear();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (store.view !== "puzzle" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key.toLowerCase() === "r") rotateDrag();
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
