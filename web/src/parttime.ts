import { RULES } from "../../shared/rules";
import { calcAnswer, JOB_IDS, levelOf, shiftMs, unitPay, upgradeCost, type JobId, type Levels, type UpgradeId } from "../../shared/parttime";
import type { ClientMsg, PtView, ServerMsg } from "../../shared/protocol";
import type { PtEnd } from "../../shared/ptrun";
import { el } from "./dom";
import { signed, won } from "./format";
import { store } from "./store";

type PtMsg = Extract<ServerMsg, { t: "pt" }>;

const REPLY_TIMEOUT_MS = 6000;
const MENU = ["돈까스", "카레", "우동", "김밥"];
const CARDS = ["🍙", "🍜", "🍛", "🍣", "🍤", "🥟", "🍡", "🍢"];
const JOB_DESC: Record<JobId, string> = {
  calc: "손님 주문 금액을 계산해요. 정답마다 돈을 받고, 오답은 감점이에요.",
  memory: "손님이 말한 메뉴 순서를 기억했다가 그대로 눌러요. 라운드가 오를수록 길어져요.",
  match: "카드를 뒤집어 같은 그림 짝을 맞춰요. 전부 맞추면 남은 시간만큼 보너스예요.",
  fry: "돈까스가 알맞게 익었을 때 건져요. 딱 맞을수록 많이 받아요.",
};
const REASON: Record<string, string> = { done: "근무 완료", time: "시간 종료", fail: "틀려서 종료", early: "일찍 마침", invalid: "비정상적인 속도라서 수입이 인정되지 않았어요" };

/**
 * 알바 화면. 문제·카드·튀김 시간은 서버가 만들고 채점·지급도 서버가 한다.
 * 여기서는 서버가 준 판을 보여 주고 입력을 보내기만 한다. (타이머도 표시용)
 */
export function createPartTimeView(): {
  el: HTMLElement;
  show: () => void;
  update: () => void;
  onResult: (m: PtMsg) => void;
  reset: () => void;
} {
  let view: PtView | null = null;
  let msg = "";
  let busy = false;
  let busyTimer: number | undefined;
  let deadlineAt = 0; // performance.now() 기준 표시용 마감
  let endAsked = false;

  // 게임별 로컬 상태
  let gameKey = "";
  let calcIdx = 0;
  let calcAnswers: (number | null)[] = [];
  let calcRight = 0;
  let calcWrong = 0;
  let memShowTimer: number | undefined;
  let memInput: number[] = [];
  let memShowing = true;
  let peek = new Map<number, number>(); // 짝 맞추기: 잠깐 보여 줄 카드
  let peekTimer: number | undefined;
  let fryStart = 0;
  let fryBadge = "";

  let timerEl: HTMLElement | null = null;
  let fryFill: HTMLElement | null = null;

  const body = el("div", { class: "pt-body" });
  const root = el("div", { class: "panel pt-view" }, el("div", { class: "panel-title" }, "알바"), body);

  const release = (): void => {
    busy = false;
    clearTimeout(busyTimer);
  };

  function send(m: ClientMsg): boolean {
    if (busy) return false;
    if (!store.conn?.send(m)) {
      msg = "서버와 연결 중입니다. 잠시 후 다시 눌러 주세요.";
      render();
      return false;
    }
    busy = true;
    busyTimer = window.setTimeout(() => {
      release();
      msg = "응답이 늦어요. 현재 상태를 다시 확인합니다.";
      store.conn?.send({ t: "pt", act: "state" });
      render();
    }, REPLY_TIMEOUT_MS);
    return true;
  }

  // ── 목록 화면 (근무 전·후) ──
  const levels = (): Levels => (view?.levels ?? {}) as Levels;

  function jobCard(job: JobId): HTMLElement {
    const lv = levels();
    const secs = RULES.PT_JOBS[job].shiftSec === 0 ? "시간 제한 없음 (라운드마다 제한)" : `${shiftMs(job, lv) / 1000}초`;
    const btn = el("button", { class: "btn btn-buy", type: "button", disabled: busy }, "근무 시작");
    btn.onclick = () => { msg = ""; send({ t: "pt", act: "start", job }); };
    return el(
      "div",
      { class: "pt-job" },
      el("div", { class: "pt-job-head" }, el("b", {}, RULES.PT_JOBS[job].title), el("span", { class: "muted num" }, `기본 ${won(unitPay(job, lv))}원 · ${secs}`)),
      el("div", { class: "muted pt-desc" }, JOB_DESC[job]),
      btn,
    );
  }

  function upgradeRow(u: (typeof RULES.PT_UPGRADES)[number]): HTMLElement {
    const lv = levelOf(levels(), u.id as UpgradeId);
    const cost = upgradeCost(u.id as UpgradeId, lv);
    const btn = el("button", { class: "btn", type: "button" }, cost === null ? "최고 레벨" : `${won(cost)}원`);
    btn.disabled = busy || cost === null || cost > store.account.cash;
    btn.onclick = () => { msg = ""; send({ t: "pt", act: "buy", id: u.id }); };
    return el(
      "div",
      { class: "pt-up" },
      el("div", {}, el("b", {}, u.title), el("span", { class: "muted num" }, `  Lv ${lv}/${u.max}`), el("div", { class: "muted pt-desc" }, u.desc)),
      btn,
    );
  }

  function endSummary(end: PtEnd): HTMLElement {
    const s = end.stats;
    const detail =
      end.job === "calc" ? `정답 ${s.correct ?? 0} · 오답 ${s.wrong ?? 0}`
      : end.job === "memory" ? `${s.rounds ?? 0}라운드 성공`
      : end.job === "match" ? `짝 ${s.found ?? 0}/${RULES.PT_MATCH_PAIRS} · 뒤집기 ${s.flips ?? 0}번`
      : `완벽 ${s.perfect ?? 0} · 괜찮음 ${s.good ?? 0} · 실패 ${s.miss ?? 0}`;
    return el(
      "div",
      { class: "pt-result" },
      el("div", { class: "pt-result-title" }, `${RULES.PT_JOBS[end.job].title} · ${REASON[end.reason] ?? ""}`),
      el("div", { class: "muted" }, detail),
      el("div", { class: `num pt-pay ${end.pay > 0 ? "up" : "muted"}` }, end.pay > 0 ? `${signed(end.pay)}원` : "수입 없음"),
    );
  }

  function renderList(): void {
    body.replaceChildren(
      el("div", { class: "lot-info muted" }, "배팅 없이 일한 만큼 돈을 벌어요. 현금이 0원이어도 할 수 있고, 번 돈은 근무가 끝나면 바로 들어와요."),
      el("div", { class: "op-row" }, el("span", { class: "muted" }, "보유 현금"), el("span", { class: "num" }, `${won(store.account.cash)}원`)),
      view?.end ? endSummary(view.end) : el("div", {}),
      msg ? el("div", { class: "warn-text" }, msg) : el("div", {}),
      el("div", { class: "pt-section" }, "알바 고르기"),
      ...JOB_IDS.map(jobCard),
      el("div", { class: "pt-section" }, "업그레이드 (영구)"),
      ...RULES.PT_UPGRADES.map(upgradeRow),
    );
    timerEl = fryFill = null;
  }

  // ── 근무 화면 공통 ──
  const run = () => view!.run!;
  const secText = (ms: number): string => `${Math.max(0, ms / 1000).toFixed(1)}초`;

  function head(extra: string): HTMLElement {
    timerEl = el("span", { class: "num pt-timer" });
    return el("div", { class: "pt-head" }, el("b", {}, RULES.PT_JOBS[run().job].title), el("span", { class: "muted" }, extra), el("span", { class: "spacer" }), timerEl);
  }

  function quit(label = "그만하기"): HTMLElement {
    const b = el("button", { class: "btn", type: "button" }, label);
    b.onclick = () => { if (run().job === "calc") submitCalc(); else send({ t: "pt", act: "end" }); };
    return b;
  }

  // ── 계산 ──
  function renderCalc(): void {
    const r = run();
    const probs = r.calc!.problems;
    const p = probs[calcIdx];
    const box = el("div", { class: "pt-calc" });
    const earn = Math.max(0, calcRight * r.unit - Math.floor((calcWrong * r.unit) / 2));
    if (!p) {
      box.appendChild(el("div", { class: "muted" }, "모든 문제를 풀었어요. 채점 중…"));
    } else {
      const input = el("input", { class: "input num pt-input", type: "number", inputMode: "numeric", placeholder: "답", autocomplete: "off" });
      const ok = el("button", { class: "btn btn-buy", type: "button" }, "확인");
      const answer = (): void => {
        if (input.value.trim() === "") return;
        const v = Number(input.value);
        calcAnswers[calcIdx] = v;
        if (v === calcAnswer(p)) calcRight++; else calcWrong++;
        calcIdx++;
        if (calcIdx >= probs.length) submitCalc(); else renderCalc();
      };
      ok.onclick = answer;
      input.onkeydown = (e) => { if (e.key === "Enter") answer(); };
      box.replaceChildren(el("div", { class: "pt-q num" }, `${p.a} ${p.op} ${p.b} = ?`), input, ok);
      window.setTimeout(() => input.focus(), 0);
    }
    body.replaceChildren(
      head(`${calcIdx}/${probs.length}번째 · 정답 ${calcRight} 오답 ${calcWrong}`),
      box,
      el("div", { class: "muted num" }, `예상 수입 ${won(earn)}원 (채점은 서버가 해요)`),
      el("div", { class: "pt-tools" }, quit("제출하고 끝내기")),
    );
  }

  function submitCalc(): void {
    // 푼 순서대로 낸다. 못 푼 문제는 null
    const answers = view!.run!.calc!.problems.map((_, i) => calcAnswers[i] ?? null);
    send({ t: "pt", act: "submit", answers });
  }

  // ── 순서 기억 ──
  function renderMemory(): void {
    const r = run();
    const m = r.memory!;
    const show = el("div", { class: "pt-mem-show" });
    const keys = el("div", { class: "pt-keys" });
    const dots = el("div", { class: "pt-dots num" }, `${memInput.length}/${m.seq.length}`);
    MENU.forEach((name, i) => {
      const b = el("button", { class: `pt-key pc${i}`, type: "button" }, name);
      b.onclick = () => {
        if (memShowing || busy) return;
        memInput.push(i);
        dots.textContent = `${memInput.length}/${m.seq.length}`;
        if (memInput.length === m.seq.length) send({ t: "pt", act: "mem", input: memInput.slice() });
      };
      keys.appendChild(b);
    });
    body.replaceChildren(
      head(`${m.round}라운드 · 적립 ${won(r.earned)}원`),
      show,
      dots,
      keys,
      el("div", { class: "pt-tools" }, quit("여기까지 하고 끝내기")),
    );
    // 순서를 하나씩 보여 준다
    memShowing = true;
    keys.classList.add("off");
    let i = 0;
    const step = (): void => {
      if (i >= m.seq.length) {
        show.replaceChildren(el("div", { class: "muted" }, "기억한 순서대로 눌러요!"));
        memShowing = false;
        keys.classList.remove("off");
        return;
      }
      show.replaceChildren(el("div", { class: `pt-mem-item pc${m.seq[i]!}` }, MENU[m.seq[i]!]!));
      i++;
      memShowTimer = window.setTimeout(() => { show.replaceChildren(el("div", { class: "pt-mem-item gap" })); memShowTimer = window.setTimeout(step, 120); }, RULES.PT_MEMORY_SHOW_MS - 120);
    };
    clearTimeout(memShowTimer);
    memShowTimer = window.setTimeout(step, 400);
  }

  // ── 짝 맞추기 ──
  function renderMatch(): void {
    const r = run();
    const m = r.match!;
    const grid = el("div", { class: "pt-cards" });
    m.cards.forEach((sym, i) => {
      const shown = sym >= 0 ? sym : peek.get(i) ?? -1;
      const b = el("button", { class: `pt-card${shown >= 0 ? " up" : ""}${sym >= 0 && !peek.has(i) ? " keep" : ""}`, type: "button" }, shown >= 0 ? CARDS[shown]! : "?");
      b.onclick = () => { if (shown < 0) send({ t: "pt", act: "flip", i }); };
      grid.appendChild(b);
    });
    body.replaceChildren(
      head(`짝 ${m.found}/${m.pairs} · 뒤집기 ${m.flips}번`),
      grid,
      el("div", { class: "muted num" }, `지금까지 ${won(m.found * r.unit)}원`),
      el("div", { class: "pt-tools" }, quit("여기까지 하고 끝내기")),
    );
  }

  // ── 튀기기 ──
  function renderFry(): void {
    const r = run();
    const f = r.fry!;
    fryFill = el("i");
    const gauge = el("div", { class: "pt-gauge" }, fryFill, el("span", { class: "pt-mark" }));
    const pullBtn = el("button", { class: "btn btn-buy btn-lg pt-pull", type: "button" }, "건지기!");
    pullBtn.onpointerdown = (e) => {
      e.preventDefault();
      if (busy) return;
      send({ t: "pt", act: "pull", ms: Math.round(performance.now() - fryStart) });
    };
    body.replaceChildren(
      head(`${f.index + 1}번째 · 적립 ${won(r.earned)}원`),
      el("div", { class: "pt-pan" }, "🍤"),
      gauge,
      el("div", { class: "muted pt-desc" }, "게이지가 끝(▼)에 닿는 순간 건져요. 너무 일찍도, 너무 늦어도 안 돼요."),
      pullBtn,
      el("div", { class: "pt-badge" }, fryBadge),
      el("div", { class: "pt-tools" }, quit("여기까지 하고 끝내기")),
    );
    fryStart = performance.now();
    tick();
  }

  function render(): void {
    if (view?.phase === "play" && view.run) {
      clearTimeout(memShowTimer);
      const j = view.run.job;
      if (j === "calc") renderCalc();
      else if (j === "memory") renderMemory();
      else if (j === "match") renderMatch();
      else renderFry();
      if (msg) body.appendChild(el("div", { class: "warn-text" }, msg));
    } else renderList();
  }

  function tick(): void {
    if (view?.phase !== "play" || !view.run) return;
    const left = Math.max(0, deadlineAt - performance.now());
    if (timerEl) timerEl.textContent = secText(left);
    if (fryFill && view.run.fry) {
      const ready = view.run.fry.readyMs;
      const t = performance.now() - fryStart;
      fryFill.style.width = `${Math.min(100, (t / ready) * 100)}%`;
      const d = Math.abs(t - ready);
      fryFill.className = d <= RULES.PT_FRY_PERFECT_MS ? "perfect" : d <= RULES.PT_FRY_GOOD_MS ? "good" : t > ready ? "burnt" : "";
    }
    if (left <= 0 && !endAsked) {
      endAsked = true;
      if (view.run.job === "calc") submitCalc();
      else if (view.run.job === "memory") window.setTimeout(() => store.conn?.send({ t: "pt", act: "state" }), RULES.PUZZLE_GRACE_MS + 400);
      else if (!busy) send({ t: "pt", act: "end" });
      else window.setTimeout(() => store.conn?.send({ t: "pt", act: "end" }), 600);
    } else if (view.run.job === "calc" && left <= 300 && !endAsked) {
      endAsked = true;
      submitCalc();
    }
  }
  window.setInterval(tick, 100);

  function applyView(v: PtView): void {
    const was = view;
    view = v;
    if (v.phase !== "play" || !v.run) { gameKey = ""; return; }
    const r = v.run;
    const key =
      r.job === "calc" ? `calc|${JSON.stringify(r.calc!.problems[0])}|${r.calc!.problems.length}`
      : r.job === "memory" ? `memory|${r.memory!.round}|${r.memory!.seq.join("")}`
      : r.job === "match" ? "match"
      : `fry|${r.fry!.index}`;
    deadlineAt = performance.now() + r.remainMs;
    if (key !== gameKey) {
      const newRun = !was || was.phase !== "play" || was.run?.job !== r.job;
      gameKey = key;
      memInput = [];
      endAsked = false;
      if (r.job === "calc" && newRun) { calcIdx = 0; calcAnswers = []; calcRight = 0; calcWrong = 0; }
      if (r.job === "match" && newRun) { peek = new Map(); }
      if (r.job === "fry" && newRun) fryBadge = "";
    }
    // 이번 요청의 부가 결과
    const info = v.info;
    if (info?.kind === "fry") fryBadge = info.grade === "perfect" ? `완벽! +${won(info.pay)}원` : info.grade === "good" ? `괜찮아요 +${won(info.pay)}원` : info.grade === "cheat" ? "무효 (시간 오류)" : "아쉬워요… 0원";
    if (info?.kind === "flip" && info.flip === "miss") {
      peek = new Map([[info.index, info.symbol], [info.other!, info.otherSymbol!]]);
      clearTimeout(peekTimer);
      peekTimer = window.setTimeout(() => { peek = new Map(); if (view?.phase === "play" && view.run?.job === "match") render(); }, 700);
    }
  }

  store.on("account", () => { if (view?.phase !== "play") render(); });
  render();

  return {
    el: root,
    show: () => { store.conn?.send({ t: "pt", act: "state" }); render(); },
    update: () => { if (view?.phase !== "play") render(); },
    /** 연결이 끊기거나 다시 맺어졌을 때: 서버에 현재 근무를 다시 물어본다 */
    reset: () => { release(); store.conn?.send({ t: "pt", act: "state" }); },
    onResult: (m) => {
      release();
      if (m.ok) { msg = ""; applyView(m.view); } else { msg = m.error; if (m.view) applyView(m.view); }
      render();
    },
  };
}
