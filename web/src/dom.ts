export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  for (const c of children) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: HTMLElement, cls: string): void {
  if (node.className !== cls) node.className = cls;
}

export interface Cell {
  text: string;
  cls?: string;
}

export interface RowSpec {
  key: string;
  cells: Cell[];
  cls?: string;
  onClick?: () => void;
}

const rowCache = new WeakMap<HTMLElement, Map<string, HTMLTableRowElement>>();

/** 키 단위로 행을 재사용하며 표를 갱신한다. (행을 매번 새로 만들지 않아 클릭이 끊기지 않는다) */
export function syncRows(tbody: HTMLElement, rows: RowSpec[], empty: string): void {
  let cache = rowCache.get(tbody);
  if (!cache) {
    cache = new Map();
    rowCache.set(tbody, cache);
  }
  if (rows.length === 0) {
    cache.clear();
    const td = el("td", { class: "muted empty", colSpan: 99 }, empty);
    tbody.replaceChildren(el("tr", {}, td));
    return;
  }
  const keep = new Set<string>();
  rows.forEach((spec, i) => {
    keep.add(spec.key);
    let tr = cache!.get(spec.key);
    if (!tr) {
      tr = document.createElement("tr");
      cache!.set(spec.key, tr);
    }
    while (tr.children.length < spec.cells.length) tr.appendChild(document.createElement("td"));
    spec.cells.forEach((c, j) => {
      const td = tr!.children[j] as HTMLElement;
      setText(td, c.text);
      setClass(td, c.cls ?? "");
    });
    setClass(tr, spec.cls ?? "");
    tr.onclick = spec.onClick ?? null;
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] ?? null);
  });
  for (const [k, tr] of cache) {
    if (!keep.has(k)) {
      tr.remove();
      cache.delete(k);
    }
  }
  // "empty" 행이 남아 있으면 제거
  for (const child of Array.from(tbody.children)) {
    if (!(child as HTMLElement).onclick && !Array.from(cache.values()).includes(child as HTMLTableRowElement)) child.remove();
  }
}
