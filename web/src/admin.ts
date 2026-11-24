import { previewMultipliers } from "../../shared/events";
import { STOCKS } from "../../shared/stocks";
import { CLIENT_VERSION } from "../../shared/version";
import { adminCall } from "./api";
import { el } from "./dom";
import { bigWon, pct, timeText, won } from "./format";
import { book } from "./pricebook";
import { store } from "./store";
import { toast } from "./toast";

/** 한 번 눌러 대기, 3초 안에 다시 누르면 실행하는 확인 버튼 */
function confirmButton(label: string, run: () => void, cls = "btn"): HTMLButtonElement {
  const b = el("button", { class: cls, type: "button" }, label);
  let timer: number | undefined;
  b.onclick = () => {
    if (timer === undefined) {
      b.textContent = "한 번 더 눌러 확인";
      timer = window.setTimeout(() => { timer = undefined; b.textContent = label; }, 3000);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    b.textContent = label;
    run();
  };
  return b;
}

interface Overview {
  online: number; sockets: number; users: number; banned: number;
  requests: { api: number; wsConnects: number; wsMessages: number; alarms: number; workerRequests: number; doRequests: number; limit: number };
  maintenance: { on: boolean; message: string }; minVersion: number; clientVersion: number;
  season: { id: number; name: string; startedAt: number } | null;
  events: { id: number; stock: number; startAt: number; endAt: number; durationMin: number; totalPct: number; headline: string; state: "scheduled" | "active" | "done" }[];
  flags: { nick: string; rate: number; nw: number }[];
}

interface AdminUserRow { id: number; nickname: string; role: string; banned: boolean; createdAt: number; cash: number | null; stars: number; online: boolean }

const stockName = (id: number): string => STOCKS.find((s) => s.id === id)?.name ?? String(id);
const card = (title: string, ...body: Node[]): HTMLElement => el("section", { class: "panel admin-card" }, el("div", { class: "panel-title" }, title), el("div", { class: "admin-body" }, ...body));
const row = (...children: Node[]): HTMLElement => el("div", { class: "op-row admin-row" }, ...children);

/** 더보기 탭: 내 정보 + (관리자만) 관리자 도구 */
export function createMoreView(opts: { onLogout: () => void; openGuide: () => void }): { el: HTMLElement; show: () => void; hide: () => void } {
  const isAdmin = store.user?.role === "admin";
  let timer: number | undefined;

  const me = card("내 정보", el("div", { class: "muted" }, `닉네임 ${store.user?.nickname ?? ""}${isAdmin ? " · 관리자" : ""}`), el("div", { class: "muted" }, `클라이언트 버전 ${CLIENT_VERSION}`));
  const menuBtn = (label: string, run: () => void, cls: string): HTMLElement => {
    const b = el("button", { class: `btn ${cls}`, type: "button" }, label);
    b.onclick = run;
    return b;
  };
  // 순위·복권·로그아웃은 데스크톱에서는 상단 바에 있으므로 모바일에서만 보인다
  const menu = card(
    "메뉴",
    el(
      "div",
      { class: "menu-grid" },
      menuBtn("순위", () => store.setView("rank"), "mobile-only"),
      menuBtn("복권", () => store.setView("lottery"), "mobile-only"),
      menuBtn("사용법 보기", opts.openGuide, ""),
      menuBtn("로그아웃", opts.onLogout, "mobile-only"),
    ),
  );
  const root = el("div", { class: "more-view" }, me, menu);

  // 관리자 키 입력 (운영자 전용). 서버가 키를 확인하고, 틀린 시도는 횟수를 제한한다.
  if (!isAdmin) {
    const keyInput = el("input", { class: "input", type: "password", placeholder: "관리자 키", autocomplete: "off" });
    const keyBtn = el("button", { class: "btn", type: "button" }, "인증");
    keyBtn.onclick = async () => {
      const r = await adminCall("POST", "/api/claim-admin", { key: keyInput.value });
      keyInput.value = "";
      if (!r.ok) return toast(r.message, "warn");
      toast("관리자로 지정되었습니다. 화면을 새로 불러옵니다.", "up");
      setTimeout(() => location.reload(), 1200);
    };
    const det = el("details", { class: "panel admin-card key-card" }, el("summary", { class: "muted" }, "관리자 인증"), el("div", { class: "admin-body" }, row(keyInput, keyBtn)));
    root.appendChild(det);
  }

  // ── 현황 ──
  const tiles = el("div", { class: "admin-tiles" });
  const flagsEl = el("div", { class: "muted admin-flags" });
  const statusCard = card("현황 (10초마다 갱신)", tiles, flagsEl);

  // ── 이벤트·뉴스 ──
  const evStock = el("select", { class: "input" });
  for (const s of STOCKS) evStock.appendChild(el("option", { value: String(s.id) }, `${s.name} (${s.code})`));
  const evStart = el("input", { class: "input num", type: "number", min: "1", value: "5" });
  const evDur = el("input", { class: "input num", type: "number", min: "1", max: "720", value: "30" });
  const evPct = el("input", { class: "input num", type: "number", step: "1", value: "15" });
  const evHead = el("input", { class: "input", placeholder: "뉴스 문구 (2~80자)", maxLength: 80 });
  const preview = el("div", { class: "ev-preview" });
  const evTable = el("tbody");
  const evSubmit = el("button", { class: "btn btn-primary", type: "button" }, "이벤트 등록");

  function drawPreview(): void {
    const dur = Math.min(720, Math.max(1, Number(evDur.value) || 1));
    const total = Number(evPct.value) || 0;
    const stock = Number(evStock.value);
    const base = book.ready ? book.priceNow(stock) : 0;
    const m = previewMultipliers(total || 0.0001, dur);
    const w = 360, h = 90, pad = 6;
    const lo = Math.min(...m), hi = Math.max(...m);
    const span = hi - lo || 1;
    const pts = m.map((v, i) => `${(pad + (i / Math.max(1, m.length - 1)) * (w - 2 * pad)).toFixed(1)},${(h - pad - ((v - lo) / span) * (h - 2 * pad)).toFixed(1)}`).join(" ");
    const color = total >= 0 ? "var(--up)" : "var(--down)";
    preview.innerHTML = "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", pts);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "2");
    svg.appendChild(line);
    preview.appendChild(svg);
    const end = base ? ` → ${won(base * (1 + total / 100))}원 (현재가 ${won(base)}원 기준)` : "";
    preview.appendChild(el("div", { class: "muted ev-note" }, `기대 경로(변동성 제외): ${dur}분 동안 ${total >= 0 ? "+" : ""}${total}%${end}. 실제 가격은 평소 변동이 섞여 달라집니다.`));
  }
  for (const i of [evStock, evDur, evPct]) i.oninput = drawPreview;
  evSubmit.onclick = async () => {
    const r = await adminCall<{ id: number }>("POST", "/api/admin/event", {
      stock: Number(evStock.value), startInMin: Number(evStart.value), durationMin: Number(evDur.value), totalPct: Number(evPct.value), headline: evHead.value,
    });
    if (!r.ok) return toast(r.message, "warn");
    toast("이벤트를 등록했습니다. 시작 시점에 뉴스와 함께 적용됩니다.", "up");
    evHead.value = "";
    refresh();
  };
  const eventCard = card(
    "이벤트·뉴스",
    row(el("span", { class: "muted" }, "종목"), evStock),
    row(el("span", { class: "muted" }, "시작 (분 뒤)"), evStart),
    row(el("span", { class: "muted" }, "지속 (분)"), evDur),
    row(el("span", { class: "muted" }, "변동률 (%)"), evPct),
    row(el("span", { class: "muted" }, "뉴스 문구"), evHead),
    preview,
    evSubmit,
    el("div", { class: "muted ev-note" }, "시작 시점이 지나기 전까지는 유저에게 공개되지 않으며, 시작 후에는 삭제할 수 없습니다 (과거 가격 불변)."),
    el("table", { class: "grid" }, el("thead", {}, el("tr", {}, ...["시작", "종목", "분", "변동", "문구", "상태", ""].map((h) => el("th", {}, h)))), evTable),
  );

  // ── 점검·버전 ──
  const mOn = el("input", { type: "checkbox" });
  const mMsg = el("input", { class: "input", placeholder: "유저에게 보일 안내 문구", maxLength: 200 });
  const mApply = el("button", { class: "btn btn-primary", type: "button" }, "점검 설정 적용");
  mApply.onclick = async () => {
    const r = await adminCall("POST", "/api/admin/maintenance", { on: mOn.checked, message: mMsg.value });
    toast(r.ok ? (mOn.checked ? "점검 모드를 켰습니다." : "점검 모드를 껐습니다.") : r.message, r.ok ? "up" : "warn");
    refresh();
  };
  const vMin = el("input", { class: "input num", type: "number", min: "0", value: "0" });
  const vApply = el("button", { class: "btn btn-primary", type: "button" }, "최소 버전 적용");
  vApply.onclick = async () => {
    const r = await adminCall("POST", "/api/admin/min-version", { version: Number(vMin.value) });
    toast(r.ok ? "최소 버전을 바꿨습니다. 낮은 버전은 새로고침 안내를 받습니다." : r.message, r.ok ? "up" : "warn");
    refresh();
  };
  const verNote = el("div", { class: "muted ev-note" });
  const maintCard = card(
    "점검 모드 · 최소 클라이언트 버전",
    row(el("label", { class: "muted" }, mOn, " 점검 모드 켜기 (관리자는 계속 사용 가능)")),
    row(el("span", { class: "muted" }, "안내 문구"), mMsg),
    mApply,
    row(el("span", { class: "muted" }, "최소 버전"), vMin),
    verNote,
    vApply,
  );

  // ── 시즌 ──
  const seasonInfo = el("div", { class: "muted" });
  const seasonName = el("input", { class: "input", placeholder: "시즌 이름 (1~30자)", maxLength: 30 });
  const seasonStart = el("button", { class: "btn btn-primary", type: "button" }, "시즌 시작");
  seasonStart.onclick = async () => {
    const r = await adminCall("POST", "/api/admin/season", { action: "start", name: seasonName.value });
    toast(r.ok ? "시즌을 시작했습니다." : r.message, r.ok ? "up" : "warn");
    refresh();
  };
  const seasonEnd = confirmButton("시즌 종료", async () => {
    const r = await adminCall("POST", "/api/admin/season", { action: "end" });
    toast(r.ok ? "시즌을 종료하고 최종 순위를 명예의 전당에 보관했습니다." : r.message, r.ok ? "up" : "warn");
    refresh();
  });
  const seasonCard = card("시즌", seasonInfo, row(seasonName, seasonStart), seasonEnd);

  // ── 유저 ──
  const uq = el("input", { class: "input", placeholder: "닉네임 검색 (비우면 최근 가입순)" });
  const uSearch = el("button", { class: "btn", type: "button" }, "검색");
  const uBody = el("tbody");
  async function searchUsers(): Promise<void> {
    const r = await adminCall<{ users: AdminUserRow[] }>("GET", `/api/admin/users?q=${encodeURIComponent(uq.value)}`);
    if (!r.ok) return void toast(r.message, "warn");
    uBody.replaceChildren(
      ...r.data.users.map((u) => {
        const rename = el("input", { class: "input", placeholder: "새 닉네임", maxLength: 12 });
        const renameBtn = el("button", { class: "btn", type: "button" }, "변경");
        renameBtn.onclick = async () => {
          const rr = await adminCall("POST", "/api/admin/user", { id: u.id, action: "rename", nickname: rename.value });
          toast(rr.ok ? "닉네임을 바꿨습니다." : rr.message, rr.ok ? "up" : "warn");
          if (rr.ok) searchUsers();
        };
        const ban = u.role === "admin" ? el("span", { class: "muted" }, "–") : confirmButton(u.banned ? "정지 해제" : "정지", async () => {
          const rr = await adminCall("POST", "/api/admin/user", { id: u.id, action: u.banned ? "unban" : "ban" });
          toast(rr.ok ? (u.banned ? "정지를 풀었습니다." : "정지했습니다.") : rr.message, rr.ok ? "up" : "warn");
          searchUsers();
        });
        const status = [u.role === "admin" ? "관리자" : "", u.banned ? "정지" : "", u.online ? "접속 중" : ""].filter(Boolean).join(" · ") || "–";
        return el(
          "tr",
          {},
          el("td", { class: "num muted" }, String(u.id)),
          el("td", {}, u.nickname + (u.stars ? ` ★${u.stars}` : "")),
          el("td", { class: u.banned ? "warn-text" : "muted" }, status),
          el("td", { class: "num" }, u.cash === null ? "–" : bigWon(u.cash)),
          el("td", {}, u.role === "admin" ? "" : rename),
          el("td", {}, u.role === "admin" ? "" : renameBtn),
          el("td", {}, ban),
        );
      }),
    );
  }
  uSearch.onclick = searchUsers;
  uq.onkeydown = (e) => { if (e.key === "Enter") searchUsers(); };
  const userCard = card(
    "유저",
    row(uq, uSearch),
    el("table", { class: "grid" }, el("thead", {}, el("tr", {}, ...["ID", "닉네임", "상태", "현금", "새 닉네임", "", ""].map((h) => el("th", {}, h)))), uBody),
  );

  if (isAdmin) for (const c of [statusCard, eventCard, maintCard, seasonCard, userCard]) root.appendChild(c);

  let loaded = false;
  async function refresh(): Promise<void> {
    if (!isAdmin) return;
    const r = await adminCall<Overview>("GET", "/api/admin/overview");
    if (!r.ok) return;
    const o = r.data;
    const pctUsed = Math.min(100, (o.requests.doRequests / o.requests.limit) * 100);
    tiles.replaceChildren(
      tile("접속자", `${o.online}명`, `연결 ${o.sockets}개`),
      tile("가입자", `${won(o.users)}명`, `정지 ${o.banned}명`),
      tile("오늘 요청(추정)", `${won(o.requests.doRequests)}`, `한도 ${won(o.requests.limit)} 중 ${pctUsed.toFixed(1)}%`, pctUsed),
      tile("API · 연결", `${won(o.requests.api)} · ${won(o.requests.wsConnects)}`, `WS 메시지 ${won(o.requests.wsMessages)} · 알람 ${o.requests.alarms}`),
    );
    flagsEl.replaceChildren(
      document.createTextNode(o.flags.length ? "비정상 수익 의심 계정 (표시만 합니다): " : "비정상 수익 의심 계정 없음"),
      ...o.flags.map((f) => el("span", { class: "warn-text" }, `${f.nick} (${pct(f.rate)}, ${bigWon(f.nw)}원) `)),
    );
    evTable.replaceChildren(
      ...o.events.map((e) => {
        const del = e.state === "scheduled" ? confirmButton("삭제", async () => {
          const rr = await adminCall("POST", "/api/admin/event/delete", { id: e.id });
          toast(rr.ok ? "삭제했습니다." : rr.message, rr.ok ? "up" : "warn");
          refresh();
        }) : el("span", {});
        return el(
          "tr",
          {},
          el("td", { class: "num muted" }, `${new Date(e.startAt + 9 * 3600e3).toISOString().slice(5, 10)} ${timeText(e.startAt)}`),
          el("td", {}, stockName(e.stock)),
          el("td", { class: "num" }, String(e.durationMin)),
          el("td", { class: `num ${e.totalPct >= 0 ? "up" : "down"}` }, `${e.totalPct >= 0 ? "+" : ""}${e.totalPct}%`),
          el("td", {}, e.headline),
          el("td", { class: e.state === "active" ? "warn-text" : "muted" }, { scheduled: "예정", active: "진행 중", done: "종료" }[e.state]),
          el("td", {}, del),
        );
      }),
    );
    if (!loaded) {
      loaded = true;
      mOn.checked = o.maintenance.on;
      mMsg.value = o.maintenance.message;
      vMin.value = String(o.minVersion);
    }
    verNote.textContent = `현재 클라이언트 버전 ${o.clientVersion}, 서버 최소 버전 ${o.minVersion}. 호환이 깨지는 배포 후에 최소 버전을 올리면 낮은 버전 접속자는 새로고침 안내를 받습니다.`;
    seasonInfo.textContent = o.season ? `진행 중: ${o.season.name} (시작 ${new Date(o.season.startedAt + 9 * 3600e3).toISOString().slice(0, 10)})` : "진행 중인 시즌이 없습니다.";
  }

  function tile(label: string, value: string, sub: string, bar?: number): HTMLElement {
    const t = el("div", { class: "admin-tile" }, el("div", { class: "muted" }, label), el("div", { class: "admin-val num" }, value), el("div", { class: "muted ev-note" }, sub));
    if (bar !== undefined) {
      const fill = el("div");
      fill.style.width = `${bar}%`;
      t.appendChild(el("div", { class: "admin-bar" }, fill));
    }
    return t;
  }

  return {
    el: root,
    show: () => {
      if (!isAdmin) return;
      drawPreview();
      refresh();
      searchUsers();
      clearInterval(timer);
      timer = window.setInterval(refresh, 10_000);
    },
    hide: () => clearInterval(timer),
  };
}
