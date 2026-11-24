import type { NewsItem } from "../../shared/protocol";
import { getStock } from "../../shared/stocks";
import { el } from "./dom";
import { timeText } from "./format";

/** 종목 정보 바 아래의 뉴스 한 줄 띠. 길면 오른쪽에서 왼쪽으로 흘러간다. */
export function createNewsStrip(): { el: HTMLElement; set: (items: NewsItem[]) => void; add: (item: NewsItem) => void } {
  let items: NewsItem[] = [];
  const inner = el("div", { class: "news-inner" });
  const root = el("div", { class: "news-strip panel", hidden: true }, el("span", { class: "news-tag" }, "뉴스"), el("div", { class: "news-track" }, inner));

  function render(): void {
    root.hidden = items.length === 0;
    inner.replaceChildren(
      ...items.map((n) => {
        let name = "";
        try { name = getStock(n.stock).name; } catch { /* 알 수 없는 종목 */ }
        return el("span", { class: "news-item" }, el("span", { class: "muted num" }, timeText(n.ts)), el("b", {}, ` [${name}] `), n.headline);
      }),
    );
    inner.classList.remove("scroll");
    // 폭이 넘치면 흘러가게 한다
    requestAnimationFrame(() => {
      const track = inner.parentElement!;
      if (inner.scrollWidth > track.clientWidth) {
        inner.style.setProperty("--dur", `${Math.max(20, Math.round(inner.scrollWidth / 60))}s`);
        inner.classList.add("scroll");
      }
    });
  }

  return {
    el: root,
    set: (list) => { items = [...list].slice(0, 10); render(); },
    add: (item) => { items = [item, ...items.filter((x) => x.id !== item.id)].slice(0, 10); render(); },
  };
}
