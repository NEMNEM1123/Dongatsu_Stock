// 틱 가격 -> OHLC 봉. 서버(체크포인트 집계)와 클라이언트(최근 구간 계산)가 같은 코드를 쓴다.

export const KST_MS = 9 * 3600 * 1000;

export const INTERVALS = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
} as const;

export type IntervalKey = keyof typeof INTERVALS;
export const INTERVAL_KEYS = Object.keys(INTERVALS) as IntervalKey[];

export interface Candle {
  t: number; // 봉 시작 시각(초). 한국 시간(KST)으로 표시되도록 +9시간 이동된 값
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** tick이 속한 봉의 시작 시각(초, KST 이동값). 1일봉은 한국 시간 자정에 끊긴다. */
export function bucketTime(tick: number, epoch: number, tickMs: number, ivMs: number): number {
  const abs = epoch + tick * tickMs + KST_MS;
  return Math.floor(abs / ivMs) * (ivMs / 1000);
}

/** 마지막 봉과 같은 구간이면 갱신, 아니면 새 봉을 추가한다. (시간 순서대로 호출) */
export function applyPrice(candles: Candle[], t: number, price: number, volume = 0): void {
  const last = candles[candles.length - 1];
  if (last && last.t === t) {
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
    last.c = price;
    last.v += volume;
  } else {
    candles.push({ t, o: price, h: price, l: price, c: price, v: volume });
  }
}
