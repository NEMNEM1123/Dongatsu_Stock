import { el } from "./dom";

let current: HTMLElement | null = null;

/** 운영자 전체 공지. 확인을 누를 때까지 화면 가운데에 남는다. 새 공지가 오면 내용을 바꾼다. */
export function showAnnounce(message: string): void {
  hideAnnounce();
  const ok = el("button", { class: "btn btn-primary btn-lg", type: "button" }, "확인");
  ok.onclick = hideAnnounce;
  current = el(
    "div",
    { class: "announce", role: "alertdialog" },
    el("div", { class: "panel overlay-box" }, el("div", { class: "overlay-title" }, "📢 공지"), el("div", { class: "overlay-msg announce-msg" }, message), ok),
  );
  document.body.appendChild(current);
}

export function hideAnnounce(): void {
  current?.remove();
  current = null;
}
