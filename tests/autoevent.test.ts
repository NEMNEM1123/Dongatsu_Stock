import { describe, expect, it } from "vitest";
import { autoEventChance, makeAutoEvent, toEffect, validateEvent } from "../shared/events";
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

  it("tick당 확률은 평균 간격에서 나옴", () => {
    expect(autoEventChance()).toBeCloseTo(RULES.TICK_MS / (RULES.AUTO_EVENT_MEAN_SEC * 1000), 10);
    expect(autoEventChance()).toBeGreaterThan(0);
    expect(autoEventChance()).toBeLessThan(0.1);
  });

  it("뉴스를 보고 따라 사는 단타가 노릴 수 있는 변동이 크지 않음 (최대 변동률은 평소 하루 변동보다 작다)", () => {
    expect(RULES.AUTO_EVENT_MAX_PCT).toBeLessThanOrEqual(5);
    expect(RULES.AUTO_EVENT_MAX_SEC).toBeLessThanOrEqual(120);
  });
});
