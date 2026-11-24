import { describe, expect, it } from "vitest";
import {
  gainValues, honorScore, liveValues, peakUpdate, rankBy, startCapital, weekIdOf, weekLabel,
} from "../shared/leaderboard";
import { RULES } from "../shared/rules";

describe("리더보드 값", () => {
  it("실시간: 순자산·수익률·명예 점수", () => {
    const v = liveValues({ id: 1, nw: 15_000_000, stars: 0 });
    expect(v).toEqual({ nw: 15_000_000, rate: 0.5, honor: 15_000_000 });
  });

  it("별이 있으면 시작 자금이 10%씩 늘어 수익률 기준이 바뀌고, 명예 점수는 별이 지배", () => {
    expect(startCapital(2)).toBe(12_000_000);
    expect(liveValues({ id: 1, nw: 12_000_000, stars: 2 }).rate).toBe(0);
    expect(honorScore(1, 0)).toBe(RULES.PRESTIGE_NET_WORTH);
    expect(honorScore(1, 5_000_000)).toBeGreaterThan(honorScore(0, 999_999_999));
  });

  it("주간·시즌: 기준 시점 대비 증가분", () => {
    const v = gainValues({ id: 1, nw: 11_000_000, stars: 0 }, { nw: 10_000_000, stars: 0 });
    expect(v).toEqual({ nw: 1_000_000, rate: 0.1, honor: 1_000_000 });
    const lose = gainValues({ id: 1, nw: 8_000_000, stars: 0 }, { nw: 10_000_000, stars: 0 });
    expect(lose.nw).toBe(-2_000_000);
    expect(lose.rate).toBe(-0.2);
  });

  it("역대: 최고값만 유지하고, 오른 때만 changed", () => {
    const a = peakUpdate(undefined, { nw: 10, rate: 0.1, honor: 10 });
    expect(a.changed).toBe(true);
    const b = peakUpdate(a.peak, { nw: 8, rate: 0.05, honor: 8 });
    expect(b.changed).toBe(false);
    expect(b.peak.nw).toBe(10);
    const c = peakUpdate(b.peak, { nw: 12, rate: 0.05, honor: 8 });
    expect(c.changed).toBe(true);
    expect(c.peak).toEqual({ nw: 12, rate: 0.1, honor: 10 });
  });
});

describe("순위", () => {
  it("값 내림차순, 동점이면 id가 작은 쪽이 앞, 순위는 연속", () => {
    const r = rankBy([{ id: 5, v: 100 }, { id: 2, v: 300 }, { id: 9, v: 100 }, { id: 1, v: 200 }]);
    expect(r.map((x) => [x.id, x.rank])).toEqual([[2, 1], [1, 2], [5, 3], [9, 4]]);
  });
});

describe("주 경계 (한국 시간 월요일 0시)", () => {
  const kst = (y: number, m: number, d: number, h: number, mi = 0) => Date.UTC(y, m - 1, d, h - 9, mi);

  it("일요일 23:59 와 월요일 00:00 은 다른 주", () => {
    expect(weekIdOf(kst(2026, 11, 29, 23, 59))).not.toBe(weekIdOf(kst(2026, 11, 30, 0, 0)));
  });

  it("월요일 0시부터 다음 일요일 23:59 까지 같은 주", () => {
    const id = weekIdOf(kst(2026, 11, 23, 0, 0)); // 2026-11-23 은 월요일
    expect(weekIdOf(kst(2026, 11, 25, 12))).toBe(id);
    expect(weekIdOf(kst(2026, 11, 29, 23, 59))).toBe(id);
    expect(weekIdOf(kst(2026, 11, 22, 23, 59))).toBe(id - 7);
    expect(weekLabel(id)).toBe("2026-11-23 주");
  });
});
