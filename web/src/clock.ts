// 서버 시각 동기화. 모든 계산은 clock.now() 기준.

export interface SyncSample {
  rtt: number;
  offset: number; // serverTime - clientTime
}

/** ping을 t0에 보내고 t1에 pong을 받았고, 서버 시각이 s일 때 (왕복 지연의 절반 보정) */
export function makeSample(t0: number, t1: number, s: number): SyncSample {
  const rtt = Math.max(0, t1 - t0);
  return { rtt, offset: s - (t0 + rtt / 2) };
}

/** 최근 샘플 중 왕복 지연이 가장 짧은 것의 offset이 가장 정확하다. */
export function bestOffset(samples: readonly SyncSample[]): number {
  let best = samples[0];
  for (const s of samples) if (s.rtt < best.rtt) best = s;
  return best.offset;
}

const MAX_SAMPLES = 8;

class Clock {
  private samples: SyncSample[] = [];
  offset = 0;

  addSample(t0: number, t1: number, serverNow: number): void {
    this.samples.push(makeSample(t0, t1, serverNow));
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.offset = bestOffset(this.samples);
  }

  /** 서버 기준 현재 시각(ms) */
  now(): number {
    return Date.now() + this.offset;
  }
}

export const clock = new Clock();
