import { RULES } from "../../shared/rules";
import { el } from "./dom";
import { won } from "./format";
import { markPatchSeen } from "./patch";

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
      `공매도는 가격이 내릴 때 이익이고, 매수처럼 ${RULES.LEVERAGES.join("·")}배를 고를 수 있습니다.`,
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
    title: "예약 주문으로 편하게",
    body: [
      "주문 패널 맨 위에서 '예약'을 고르면, 가격이 내가 정한 값에 닿았을 때 자동으로 사고팔아요. 접속을 끊어 둬도 동작해요.",
      `산 종목을 팔 때 '손절 -${RULES.RESERVE_STOP_PCT * 100}%'나 '익절 +${RULES.RESERVE_TAKE_PCT * 100}%' 버튼을 누르면 가격이 자동으로 채워져요.`,
      "손절을 미리 걸어 두면 크게 잃는 것을 막을 수 있어요.",
    ],
  },
  {
    title: "더 즐기기",
    body: [
      `복권: 1장 ${won(RULES.LOTTERY_PRICE)}원, 하루 ${RULES.LOTTERY_PER_DAY}장까지. 매일 새 미션을 달성하면 보상금도 받아요.`,
      `순자산이 0이 되면 하루 ${RULES.BAILOUT_PER_DAY}번까지 파산 구제금 ${won(RULES.BAILOUT_AMOUNT)}원을 받을 수 있어요.`,
      `순자산 ${won(RULES.PRESTIGE_NET_WORTH)}원을 넘으면 프레스티지로 자산을 초기화하고 ★을 얻습니다. 별 하나마다 시작 자금이 ${RULES.PRESTIGE_BONUS_PER_STAR * 100}% 늘어요.`,
      "더 자세한 설명은 위쪽 '사용법'(휴대폰은 더보기 → 사용법)에서 언제든 볼 수 있어요. 새 소식은 '패치노트'에 올라와요.",
    ],
  },
];

export const guideSeen = (): boolean => localStorage.getItem(KEY) === "1";

/** 첫 접속 빠른 시작 안내 (슬라이드 6장, 30초 안팎). 건너뛰거나 끝내면 다시 뜨지 않고, 더보기에서 다시 볼 수 있다. */
export function showGuide(): void {
  const list = steps();
  let i = 0;
  const finish = () => {
    if (!guideSeen()) markPatchSeen(); // 처음 온 사람에게 지난 패치 알림은 필요 없다 (다시 보기로 연 경우는 건드리지 않는다)
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
    root.querySelector(".guide-step")!.textContent = `빠른 시작 ${i + 1} / ${list.length}`;
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
