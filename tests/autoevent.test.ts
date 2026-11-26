import { describe, expect, it } from "vitest";
import { planAutoEvent, makeAutoEvent, toEffect, validateEvent } from "../shared/events";
import { RULES } from "../shared/rules";
import { STOCKS } from "../shared/stocks";
import { mulberry32 } from "../shared/prng";

const tradable = STOCKS.filter((s) => s.kind !== "etf");

describe("자동 이벤트", () => {
  it("만들어진 이벤트는 모두 등록 규칙을 통과", () => {
    const rnd = mulberry32(1);
    for (let i = 0; i < 2000; i++) {
      const s = tradable[i % tradable.length]!;
      const e = makeAutoEvent(rnd, s, 100 + RULES.EVENT_MIN_LEAD_TICKS);
      expect(validateEvent(e, 100, true)).toBeNull();
    }
  });

  it("변동률·지속 시간이 설정 범위 안이고 짧다 (최대 2분)", () => {
    const rnd = mulberry32(2);
    for (let i = 0; i < 2000; i++) {
      const e = makeAutoEvent(rnd, tradable[0]!, 10);
      const pct = Math.abs(e.totalPct);
      expect(pct).toBeGreaterThanOrEqual(RULES.AUTO_EVENT_MIN_PCT);
      expect(pct).toBeLessThanOrEqual(RULES.AUTO_EVENT_MAX_PCT);
      const sec = e.durationMin * 60;
      expect(sec).toBeGreaterThanOrEqual(RULES.AUTO_EVENT_MIN_SEC);
      expect(sec).toBeLessThanOrEqual(RULES.AUTO_EVENT_MAX_SEC);
      expect(sec % 10).toBe(0);
      const fx = toEffect(e);
      expect((fx.endTick - fx.startTick) * RULES.TICK_MS).toBe(sec * 1000);
    }
  });

  it("호재와 악재가 섞여 나오고, 문구가 방향과 종목 이름을 담음", () => {
    const rnd = mulberry32(3);
    let up = 0, down = 0;
    for (let i = 0; i < 1000; i++) {
      const s = tradable[i % tradable.length]!;
      const e = makeAutoEvent(rnd, s, 10);
      if (e.totalPct > 0) up++; else down++;
      expect(e.headline).toContain(s.name);
      expect(e.headline).not.toContain("{n}");
      expect(e.headline.length).toBeLessThanOrEqual(80);
    }
    expect(up).toBeGreaterThan(400);
    expect(down).toBeGreaterThan(400);
  });

  it("코인과 주식은 서로 다른 문구 풀을 씀", () => {
    const stock = tradable.find((s) => s.kind === "stock")!;
    const coin = tradable.find((s) => s.kind === "coin")!;
    const a = new Set<string>(), b = new Set<string>();
    const rnd = mulberry32(4);
    for (let i = 0; i < 300; i++) { a.add(makeAutoEvent(rnd, stock, 1).headline.replace(stock.name, "")); b.add(makeAutoEvent(rnd, coin, 1).headline.replace(coin.name, "")); }
    for (const h of a) expect(b.has(h)).toBe(false);
  });

  it("같은 난수열이면 같은 이벤트", () => {
    expect(makeAutoEvent(mulberry32(9), tradable[2]!, 50)).toEqual(makeAutoEvent(mulberry32(9), tradable[2]!, 50));
  });

  const ticks = (sec: number) => (sec * 1000) / RULES.TICK_MS;
  const min = ticks(RULES.AUTO_EVENT_MIN_GAP_SEC);
  const max = ticks(RULES.AUTO_EVENT_MAX_GAP_SEC);

  it("접속이 이어지면 이벤트 간격이 항상 최소~최대 범위 안", () => {
    const rnd = mulberry32(5);
    let saved: number | null = null;
    const at: number[] = [];
    for (let t = 0; t < 100_000; t++) {
      const plan: { due: boolean; next: number } = planAutoEvent(saved, t, rnd);
      saved = plan.next;
      if (plan.due) at.push(t);
    }
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps.length).toBeGreaterThan(500);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(min);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(max);
  });

  it("짧게 끊겼다 돌아오면 지난 예정을 바로 실행", () => {
    const late = ticks(RULES.AUTO_EVENT_IDLE_GRACE_SEC);
    expect(planAutoEvent(1000, 1000 + late, mulberry32(6)).due).toBe(true);
  });

  it("오래 비었거나 tick 기준이 바뀌면 바로 만들지 않고 간격을 새로 정함", () => {
    for (const [saved, cur] of [[null, 5000], [1000, 1001 + ticks(RULES.AUTO_EVENT_IDLE_GRACE_SEC)], [900_000, 10]] as const) {
      const plan = planAutoEvent(saved, cur, mulberry32(7));
      expect(plan.due).toBe(false);
      expect(plan.next - cur).toBeGreaterThanOrEqual(min);
      expect(plan.next - cur).toBeLessThanOrEqual(max);
    }
  });

  it("뉴스를 보고 따라 사는 단타가 노릴 수 있는 변동이 크지 않음 (최대 변동률은 평소 하루 변동보다 작다)", () => {
    expect(RULES.AUTO_EVENT_MAX_PCT).toBeLessThanOrEqual(5);
    expect(RULES.AUTO_EVENT_MAX_SEC).toBeLessThanOrEqual(120);
  });
});
