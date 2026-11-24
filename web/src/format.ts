export const won = (n: number): string => Math.round(n).toLocaleString("ko-KR");

export const signed = (n: number): string => `${n > 0 ? "+" : ""}${won(n)}`;

export function pct(x: number): string {
  const fixed = (x * 100).toFixed(2);
  if (Number(fixed) === 0) return "0.00%"; // -0.00% 방지
  return `${x > 0 ? "+" : ""}${fixed}%`;
}

/** 큰 숫자: 1.2억, 3,450만 (1만 미만은 그대로) */
export function bigWon(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e8) {
    const v = a / 1e8;
    return `${sign}${v >= 100 ? Math.round(v).toLocaleString("ko-KR") : String(Number(v.toFixed(2)))}억`;
  }
  if (a >= 1e4) return `${sign}${Math.floor(a / 1e4).toLocaleString("ko-KR")}만`;
  return `${sign}${won(a)}`;
}

/** 수량·거래량 축약: 1.2만, 3,450 */
export function shortQty(n: number): string {
  if (n >= 1e8) return `${Number((n / 1e8).toFixed(1))}억`;
  if (n >= 1e4) return `${Number((n / 1e4).toFixed(1))}만`;
  return won(n);
}

export const tone = (n: number): string => (n > 0 ? "up" : n < 0 ? "down" : "");

export function timeText(ts: number): string {
  const d = new Date(ts + 9 * 3600 * 1000); // 한국 시간
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
