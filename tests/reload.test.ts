import { describe, expect, it } from "vitest";
import { assetSignature, createVersionCheck, MAX_RELOADS, nextReload } from "../web/src/reload";

const page = (js: string, css = "a") => `<script type="module" crossorigin src="/assets/index-${js}.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-${css}.css">`;

function setup(pages: (string | null)[], store = new Map<string, string>()) {
  let reloads = 0;
  const check = createVersionCheck({
    current: assetSignature(page("old"))!,
    fetchPage: async () => pages.shift() ?? null,
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }),
    reload: () => { reloads++; },
  });
  const run = async () => { for (let n = pages.length; n > 0; n--) await check(); return reloads; };
  return { run };
}

describe("자동 새로고침", () => {
  it("빌드 파일 목록은 순서와 상관없고, js나 css 하나만 바뀌어도 달라진다", () => {
    expect(assetSignature("/assets/b.css /assets/a-_1.js")).toBe(assetSignature('src="/assets/a-_1.js" href="/assets/b.css"'));
    expect(assetSignature(page("old", "b"))).not.toBe(assetSignature(page("old", "a")));
    expect(assetSignature("<html>점검 중</html>")).toBeNull();
  });

  it("같은 파일이면 새로고침하지 않는다", async () => {
    expect(await setup([page("old"), page("old"), page("old")]).run()).toBe(0);
  });

  it("새 파일이 두 번 연속 보이면 새로고침한다", async () => {
    expect(await setup([page("new")]).run()).toBe(0);
    expect(await setup([page("new"), page("new")]).run()).toBe(1);
  });

  it("옛 파일과 새 파일이 번갈아 내려오는 동안에는 기다린다", async () => {
    expect(await setup([page("new"), page("old"), page("new"), page("old")]).run()).toBe(0);
  });

  it("확인에 실패하거나 빌드 파일이 없는 응답은 무시한다", async () => {
    expect(await setup([null, "<html>오류</html>", null]).run()).toBe(0);
    expect(await setup([page("new"), null, page("new")]).run()).toBe(1);
  });

  it("새로고침해도 계속 옛 화면이면 정해진 횟수에서 멈춘다", async () => {
    const store = new Map<string, string>(); // 새로고침해도 남는 저장소
    let total = 0;
    for (let i = 0; i < 10; i++) total += await setup([page("new"), page("new")], store).run();
    expect(total).toBe(MAX_RELOADS);
  });

  it("다른 새 파일이 나오면 횟수를 다시 센다", () => {
    expect(nextReload(`x ${MAX_RELOADS}`, "x")).toBeNull();
    expect(nextReload(`x ${MAX_RELOADS}`, "y")).toBe("y 1");
    expect(nextReload("1.6.6", "y")).toBe("y 1"); // 예전 방식의 기록
  });
});
