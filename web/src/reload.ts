// 새 버전 자동 새로고침. 첫 페이지(index.html)를 주기적으로 받아서, 지금 화면이 쓰는 것과 다른 화면 파일이 내려오면 새로고침한다.
// 서버 재접속에 기대지 않고, 새 파일이 실제로 내려오는 것을 본 뒤에만 새로고침한다.

export const CHECK_INTERVAL_MS = 30_000;
export const MAX_RELOADS = 3; // 같은 새 파일을 목표로 한 새로고침 횟수 상한 (무한 반복 방지)
const STORAGE_KEY = "reloadedFor";

/** HTML이나 경로 목록에서 빌드 파일(/assets/ 아래의 js·css)을 뽑아 비교용 문자열로 만든다. 없으면 null. */
export function assetSignature(text: string): string | null {
  const found = text.match(/\/assets\/[\w.-]+\.(?:js|css)/g);
  return found ? [...new Set(found)].sort().join(",") : null;
}

/** record는 저장해 둔 이전 시도 기록("목표 횟수"). 더 시도해도 되면 새 기록을, 그만해야 하면 null을 돌려준다. */
export function nextReload(record: string | null, target: string): string | null {
  const [saved, count] = (record ?? "").split(" ");
  const done = saved === target ? Number(count) || 0 : 0;
  return done < MAX_RELOADS ? `${target} ${done + 1}` : null;
}

export interface WatchDeps {
  current: string; // 지금 화면의 빌드 파일 목록
  fetchPage: () => Promise<string | null>; // 첫 페이지 HTML. 실패하면 null
  storage: () => Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
}

/**
 * 한 번 확인하는 함수를 만든다. 배포 중에는 옛 파일과 새 파일이 번갈아 내려올 수 있어서,
 * 두 번 연속으로 같은 새 파일이 보일 때만 새로고침한다.
 */
export function createVersionCheck(deps: WatchDeps): () => Promise<void> {
  let seen: string | null = null;
  return async () => {
    const html = await deps.fetchPage().catch(() => null);
    const latest = html === null ? null : assetSignature(html);
    if (latest === null) return; // 확인하지 못함: 다음 번에 다시
    if (latest === deps.current) { seen = null; return; }
    if (latest !== seen) { seen = latest; return; }
    try {
      const store = deps.storage();
      const record = nextReload(store.getItem(STORAGE_KEY), latest);
      if (record === null) return;
      store.setItem(STORAGE_KEY, record);
    } catch {
      return; // 저장소를 못 쓰면 반복을 막을 수 없으므로 새로고침하지 않는다
    }
    deps.reload();
  };
}

/** 브라우저에서 확인을 시작한다. 화면이 다시 보일 때도 바로 확인한다. */
export function watchForNewVersion(): void {
  const tags = document.querySelectorAll('script[src^="/assets/"], link[href^="/assets/"]');
  const current = assetSignature([...tags].map((t) => t.getAttribute("src") ?? t.getAttribute("href") ?? "").join(" "));
  if (current === null) return;
  const check = createVersionCheck({
    current,
    fetchPage: async () => {
      const r = await fetch("/", { cache: "no-store" });
      return r.ok ? r.text() : null;
    },
    storage: () => sessionStorage,
    reload: () => location.reload(),
  });
  window.setInterval(() => void check(), CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
}
