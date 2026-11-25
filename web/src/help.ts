// 사용법 · 패치노트 화면

import { PATCH_NOTES, PATCH_TAG_LABEL } from "../../shared/patchnotes";
import { el } from "./dom";
import { helpSections, type Block, type Section } from "./helpcontent";
import { patchUnseen } from "./patch";
import { store, type HelpTab } from "./store";

function renderBlock(b: Block): HTMLElement {
  if ("p" in b) return el("p", {}, b.p);
  if ("ul" in b) return el("ul", { class: "help-list" }, ...b.ul.map((t) => el("li", {}, t)));
  if ("ol" in b) return el("ol", { class: "help-list help-steps" }, ...b.ol.map((t) => el("li", {}, t)));
  if ("ex" in b) return el("div", { class: "help-box help-ex" }, ...b.ex.map((t, i) => el("div", { class: i === 0 ? "help-box-title" : "" }, t)));
  if ("tip" in b) return el("div", { class: "help-box help-tip" }, el("b", {}, "TIP "), b.tip);
  if ("warn" in b) return el("div", { class: "help-box help-warn" }, el("b", {}, "주의 "), b.warn);
  return el(
    "table",
    { class: "grid help-table" },
    el("thead", {}, el("tr", {}, ...b.table.head.map((h) => el("th", {}, h)))),
    el("tbody", {}, ...b.table.rows.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, c))))),
  );
}

const blockText = (b: Block): string =>
  "p" in b ? b.p : "ul" in b ? b.ul.join(" ") : "ol" in b ? b.ol.join(" ") : "ex" in b ? b.ex.join(" ") : "tip" in b ? b.tip : "warn" in b ? b.warn : [...b.table.head, ...b.table.rows.flat()].join(" ");

/** 사용법(초보자용 설명, 검색 가능) + 패치노트 */
export function createHelpView(): { el: HTMLElement; show: () => void } {
  const sections: Section[] = helpSections();
  const texts = new Map(sections.map((s) => [s.id, `${s.title} ${s.blocks.map(blockText).join(" ")}`.toLowerCase()]));

  const tabBtns = new Map<HelpTab, HTMLElement>();
  const tabs = el("div", { class: "tabs help-tabs" });
  const patchDot = el("span", { class: "dot", hidden: true });
  for (const [k, label] of [["guide", "사용법"], ["patch", "패치노트"]] as [HelpTab, string][]) {
    const b = el("button", { class: "tab", type: "button" }, label);
    if (k === "patch") b.appendChild(patchDot);
    b.onclick = () => store.openHelp(k);
    tabBtns.set(k, b);
    tabs.appendChild(b);
  }

  // ── 사용법 ──
  const search = el("input", { class: "input", type: "search", placeholder: "사용법 검색 (예: 손절, 레버리지, 복권)" });
  const toc = el("div", { class: "help-toc" });
  const body = el("div", { class: "help-body" });
  const empty = el("div", { class: "muted empty", hidden: true }, "검색 결과가 없습니다.");
  const secEls = new Map<string, HTMLElement>();
  for (const s of sections) {
    const chip = el("button", { class: "chip", type: "button" }, s.title.replace(/^\d+\.\s*/, ""));
    chip.onclick = () => {
      search.value = "";
      applyFilter();
      secEls.get(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    toc.appendChild(chip);
    const sec = el("section", { class: "help-sec", id: `help-${s.id}` }, el("h3", {}, s.title), ...s.blocks.map(renderBlock));
    secEls.set(s.id, sec);
    body.appendChild(sec);
  }
  function applyFilter(): void {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const s of sections) {
      const hit = !q || texts.get(s.id)!.includes(q);
      secEls.get(s.id)!.hidden = !hit;
      if (hit) shown++;
    }
    empty.hidden = shown > 0;
  }
  search.oninput = applyFilter;
  const guidePane = el("div", { class: "help-pane" }, el("div", { class: "help-head" }, search, toc), body, empty);

  // ── 패치노트 ──
  const patchPane = el("div", { class: "help-pane" });
  for (const n of PATCH_NOTES) {
    patchPane.appendChild(
      el(
        "article",
        { class: "patch-card" },
        el("div", { class: "patch-head" }, el("span", { class: "patch-title" }, n.title), el("span", { class: "muted num" }, n.date)),
        el(
          "ul",
          { class: "help-list patch-list" },
          ...n.items.map((it) => el("li", {}, el("span", { class: `patch-tag ${it.tag}` }, PATCH_TAG_LABEL[it.tag]), it.text)),
        ),
      ),
    );
  }

  const root = el("div", { class: "panel help-view" }, tabs, guidePane, patchPane);

  function render(): void {
    for (const [k, b] of tabBtns) b.setAttribute("aria-selected", String(k === store.helpTab));
    guidePane.hidden = store.helpTab !== "guide";
    patchPane.hidden = store.helpTab !== "patch";
    patchDot.hidden = !patchUnseen();
    root.scrollTop = 0;
  }
  store.on("help", render);
  render();

  return { el: root, show: render };
}
