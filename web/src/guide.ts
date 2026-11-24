import { RULES } from "../../shared/rules";
import { el } from "./dom";
import { won } from "./format";

const KEY = "dg.guide";

interface Step {
  title: string;
  body: string[];
}

const steps = (): Step[] => [
  {
    title: "모두가 같은 시세",
    body: [
      "모든 유저가 같은 가격, 같은 그래프를 실시간으로 봅니다.",
      `시작 자금은 ${won(RULES.START_CASH)}원. 순자산으로 순위를 겨룹니다.`,
    ],
  },
  {
    title: "종목과 차트",
    body: [
      "종목을 고르면 차트와 호가가 바뀝니다. ★을 눌러 관심 종목에 담을 수 있어요.",
      "차트는 1분·5분·1시간·1일로 바꿔 볼 수 있습니다.",
    ],
  },
  {
    title: "매수 · 매도 · 공매도",
    body: [
      `수량을 넣고 실행하세요. 수수료는 ${(RULES.FEE_RATE * 100).toFixed(1)}%입니다.`,
      `공매도는 가격이 내릴 때 이익이고, 금액의 ${RULES.SHORT_MARGIN * 100}%가 증거금으로 묶입니다.`,
      "체결가는 항상 서버의 현재가입니다. 화면 가격과 다르면 '가격 변동됨'으로 알려 줘요.",
    ],
  },
  {
    title: "레버리지와 강제 청산",
    body: [
      "2·3·5배는 이익도 손실도 그만큼 커집니다.",
      `손실이 내 증거금의 ${Math.round((1 - RULES.MAINTENANCE_MARGIN) * 100)}%에 이르면 강제 청산됩니다. 차트의 노란 점선이 청산가예요.`,
    ],
  },
  {
    title: "더 즐기기",
    body: [
      `복권: 1장 ${won(RULES.LOTTERY_PRICE)}원, 하루 ${RULES.LOTTERY_PER_DAY}장까지.`,
      `순자산이 0이 되면 하루 한 번 파산 구제금 ${won(RULES.BAILOUT_AMOUNT)}원을 받을 수 있어요.`,
      `순자산 ${won(RULES.PRESTIGE_NET_WORTH)}원을 넘으면 프레스티지로 자산을 초기화하고 ★을 얻습니다. 별 하나마다 시작 자금이 ${RULES.PRESTIGE_BONUS_PER_STAR * 100}% 늘어요.`,
    ],
  },
];

export const guideSeen = (): boolean => localStorage.getItem(KEY) === "1";

/** 첫 접속 사용법 안내 (슬라이드 5장, 30초 안팎). 건너뛰거나 끝내면 다시 뜨지 않고, 더보기에서 다시 볼 수 있다. */
export function showGuide(): void {
  const list = steps();
  let i = 0;
  const finish = () => {
    localStorage.setItem(KEY, "1");
    root.remove();
    document.removeEventListener("keydown", onKey);
  };

  const title = el("div", { class: "guide-title" });
  const body = el("div", { class: "guide-body" });
  const dots = el("div", { class: "guide-dots" });
  const prev = el("button", { class: "btn", type: "button" }, "이전");
  const next = el("button", { class: "btn btn-primary", type: "button" }, "다음");
  const skip = el("button", { class: "link-btn", type: "button" }, "건너뛰기");
  prev.onclick = () => { i = Math.max(0, i - 1); render(); };
  next.onclick = () => { if (i >= list.length - 1) finish(); else { i++; render(); } };
  skip.onclick = finish;

  const root = el(
    "div",
    { class: "guide", role: "dialog" },
    el("div", { class: "panel guide-box" }, el("div", { class: "muted guide-step" }), title, body, dots, el("div", { class: "guide-actions" }, skip, el("div", { class: "spacer" }), prev, next)),
  );

  function render(): void {
    const s = list[i];
    root.querySelector(".guide-step")!.textContent = `사용법 ${i + 1} / ${list.length}`;
    title.textContent = s.title;
    body.replaceChildren(...s.body.map((t) => el("p", {}, t)));
    dots.replaceChildren(...list.map((_, k) => el("span", { class: `guide-dot${k === i ? " on" : ""}` })));
    prev.hidden = i === 0;
    next.textContent = i === list.length - 1 ? "시작하기" : "다음";
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") finish();
    else if (e.key === "ArrowRight" || e.key === "Enter") next.click();
    else if (e.key === "ArrowLeft") prev.click();
  };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(root);
  render();
  next.focus();
}
