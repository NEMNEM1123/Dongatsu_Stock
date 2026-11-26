// 새 버전 자동 새로고침 판단. 배포 직후에는 새로고침해도 옛 화면 파일이 내려올 수 있어서 간격을 두고 다시 시도한다.
// 같은 버전으로는 정해진 횟수까지만 시도해서 새로고침이 무한 반복되지 않게 한다.

export const RELOAD_DELAYS_MS: readonly number[] = [0, 5_000, 20_000];

/**
 * 서버 버전이 화면 버전보다 높은지. "1.10.0"이 "1.9.0"보다 높도록 자리마다 숫자로 비교한다.
 * 화면이 더 높으면(배포 직후 잠깐 옛 서버에 접속한 경우) 새로고침하지 않는다. 그래서 이전 버전으로 되돌린 배포는 자동 적용되지 않는다.
 */
export function isNewer(server: string, client: string): boolean {
  const a = server.split(".").map(Number);
  const b = client.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * record는 저장해 둔 이전 시도 기록("버전 횟수"). 더 시도하면 기다릴 시간과 새 기록을, 그만해야 하면 null을 돌려준다.
 * 횟수가 없는 기록은 예전 방식(버전만 저장)이므로 한 번 시도한 것으로 본다.
 */
export function nextReload(record: string | null, version: string): { delayMs: number; record: string } | null {
  const [saved, count] = (record ?? "").split(" ");
  const done = saved !== version ? 0 : count === undefined ? 1 : Number(count);
  const delayMs = RELOAD_DELAYS_MS[done];
  return delayMs === undefined ? null : { delayMs, record: `${version} ${done + 1}` };
}
