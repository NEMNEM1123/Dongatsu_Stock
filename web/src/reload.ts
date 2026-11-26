// 새 버전 자동 새로고침 판단. 배포 직후에는 새로고침해도 옛 화면 파일이 내려올 수 있어서 간격을 두고 다시 시도한다.
// 같은 버전으로는 정해진 횟수까지만 시도해서 새로고침이 무한 반복되지 않게 한다.

export const RELOAD_DELAYS_MS: readonly number[] = [0, 5_000, 20_000];

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
