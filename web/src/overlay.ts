import { el } from "./dom";

let current: HTMLElement | null = null;

/** 화면 전체를 덮는 안내 (점검 중, 새 버전, 정지). 같은 종류를 다시 부르면 내용만 바꾼다. */
export function showOverlay(title: string, message: string, action?: { label: string; run: () => void }): void {
  hideOverlay();
  const box = el("div", { class: "panel overlay-box" }, el("div", { class: "overlay-title" }, title), el("div", { class: "muted overlay-msg" }, message));
  if (action) {
    const b = el("button", { class: "btn btn-primary btn-lg", type: "button" }, action.label);
    b.onclick = action.run;
    box.appendChild(b);
  }
  current = el("div", { class: "overlay" }, box);
  document.body.appendChild(current);
}

export function hideOverlay(): void {
  current?.remove();
  current = null;
}
