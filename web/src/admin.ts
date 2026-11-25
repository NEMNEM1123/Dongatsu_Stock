import { STOCKS } from "../../shared/stocks";
import { APP_VERSION, CLIENT_VERSION } from "../../shared/version";
import { adminCall } from "./api";
import { el } from "./dom";
import { bigWon, pct, timeText, won } from "./format";
import { patchUnseen } from "./patch";
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

  const me = card("내 정보", el("div", { class: "muted" }, `닉네임 ${store.user?.nickname ?? ""}${isAdmin ? " · 관리자" : ""}`), el("div", { class: "muted" }, `앱 버전 ${APP_VERSION} (호환 번호 ${CLIENT_VERSION})`));
  const menuBtn = (label: string, run: () => void, cls: string): HTMLElement => {
    const b = el("button", { class: `btn ${cls}`, type: "button" }, label);
    b.onclick = run;
    return b;
  };
  // 패치노트는 어느 화면에서든 보인다. 안 읽은 새 패치가 있으면 점을 표시한다.
  const patchBtn = menuBtn("패치노트", () => store.openHelp("patch"), "");
  const syncPatchDot = () => patchBtn.classList.toggle("has-dot", patchUnseen());
  store.on("help", syncPatchDot);
  syncPatchDot();
  // 순위·복권·사용법·로그아웃은 데스크톱에서는 상단 바에 있으므로 모바일에서만 보인다
  const menu = card(
    "메뉴",
    el(
      "div",
      { class: "menu-grid" },
      menuBtn("순위", () => store.setView("rank"), "mobile-only"),
      menuBtn("복권", () => store.setView("lottery"), "mobile-only"),
      menuBtn("퍼즐", () => store.setView("puzzle"), "mobile-only"),
      menuBtn("알바", () => store.setView("job"), "mobile-only"),
      menuBtn("사용법", () => store.openHelp("guide"), "mobile-only"),
      patchBtn,
      menuBtn("빠른 시작 안내", opts.openGuide, ""),
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

  // ── 이벤트·뉴스 (자동 발생: 기록만 본다) ──
  const evTable = el("tbody");
  const eventCard = card(
    "이벤트·뉴스 (자동 발생)",
    el("div", { class: "muted ev-note" }, "이벤트는 서버가 접속자가 있는 동안 무작위로 만듭니다. 운영자가 등록하거나 삭제할 수 없고, 아래는 최근 기록입니다."),
    el("table", { class: "grid" }, el("thead", {}, el("tr", {}, ...["시작", "종목", "초", "변동", "문구", "상태"].map((h) => el("th", {}, h)))), evTable),
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
      ...o.events.map((e) =>
        el(
          "tr",
          {},
          el("td", { class: "num muted" }, `${new Date(e.startAt + 9 * 3600e3).toISOString().slice(5, 10)} ${timeText(e.startAt)}`),
          el("td", {}, stockName(e.stock)),
          el("td", { class: "num" }, String(Math.round((e.endAt - e.startAt) / 1000))),
          el("td", { class: `num ${e.totalPct >= 0 ? "up" : "down"}` }, `${e.totalPct >= 0 ? "+" : ""}${e.totalPct}%`),
          el("td", {}, e.headline),
          el("td", { class: e.state === "active" ? "warn-text" : "muted" }, { scheduled: "예정", active: "진행 중", done: "종료" }[e.state]),
        ),
      ),
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
      refresh();
      searchUsers();
      clearInterval(timer);
      timer = window.setInterval(refresh, 10_000);
    },
    hide: () => clearInterval(timer),
  };
}
