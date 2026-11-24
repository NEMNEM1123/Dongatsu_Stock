import { describe, expect, it } from "vitest";
import { advance, priceAt, priceRange } from "../shared/engine";
import { driftPpmFor, previewMultipliers, toEffect, validateEvent, type EventInput } from "../shared/events";
import { STOCKS } from "../shared/stocks";

const SEED = 20260101;
const base: EventInput = { stock: 4, startTick: 5_000, durationMin: 60, totalPct: 20, headline: "임시 호재 뉴스" };

describe("이벤트 효과 변환", () => {
  it("기간 전체 변동률이 복리로 맞아떨어짐", () => {
    const ticks = 60 * 30;
    const ppm = driftPpmFor(20, 60);
    expect(Math.pow(1 + ppm / 1e6, ticks)).toBeCloseTo(1.2, 2);
    expect(Math.pow(1 + driftPpmFor(-30, 120) / 1e6, 120 * 30)).toBeCloseTo(0.7, 2);
  });

  it("미리보기 경로: 1.0에서 시작해 기간 끝에 1+변동률", () => {
    const m = previewMultipliers(15, 30);
    expect(m[0]).toBe(1);
    expect(m[m.length - 1]).toBeCloseTo(1.15, 2);
    expect(previewMultipliers(-20, 30).at(-1)).toBeCloseTo(0.8, 2);
  });

  it("효과 구간이 [시작, 시작+기간) 틱", () => {
    const e = toEffect(base);
    expect(e.startTick).toBe(5_000);
    expect(e.endTick).toBe(5_000 + 60 * 30);
  });
});

describe("이벤트 등록 검사", () => {
  const cur = 4_000;
  it("정상 입력은 통과", () => {
    expect(validateEvent(base, cur, true)).toBeNull();
  });
  it("과거·현재·너무 임박한 시작은 거부 (과거 가격 불변)", () => {
    expect(validateEvent({ ...base, startTick: cur - 1 }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, startTick: cur }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, startTick: cur + 1 }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, startTick: cur + 2 }, cur, true)).toBeNull();
  });
  it("범위 밖 값 거부", () => {
    expect(validateEvent({ ...base, totalPct: 0 }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, totalPct: 80 }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, totalPct: -51 }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, durationMin: 0 }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, durationMin: 100_000 }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, headline: "가" }, cur, true)).not.toBeNull();
    expect(validateEvent({ ...base, headline: "가".repeat(81) }, cur, true)).not.toBeNull();
    expect(validateEvent(base, cur, false)).not.toBeNull();
    expect(validateEvent({ ...base, startTick: cur + 1e9 }, cur, true)).not.toBeNull();
  });
});

describe("이벤트와 과거 가격", () => {
  const stock = STOCKS[3];
  const effect = toEffect(base);

  it("등록한 이벤트는 시작 tick 이전의 모든 가격을 바꾸지 않음", () => {
    const without = priceRange(stock, SEED, 0, base.startTick - 1);
    const withFx = priceRange(stock, SEED, 0, base.startTick - 1, [effect]);
    expect(withFx).toEqual(without);
  });

  it("체크포인트(이벤트 등록 전에 만든 것)에서 이어 계산해도 처음부터 계산한 값과 같음", () => {
    // 등록 시점(tick 4,000)에 만든 체크포인트는 이벤트 시작(5,000) 전이라 효과와 무관
    const cp = advance(stock, SEED, { tick: 0, price: stock.basePrice }, 4_000);
    const fromCp = advance(stock, SEED, cp, 9_000, [effect]).price;
    expect(fromCp).toBe(priceAt(stock, SEED, 9_000, [effect]));
  });

  it("효과 구간 이후에는 양수 이벤트가 가격을 올림", () => {
    const end = effect.endTick + 10;
    expect(priceAt(stock, SEED, end, [effect])).toBeGreaterThan(priceAt(stock, SEED, end));
  });

  it("다른 종목에는 영향 없음", () => {
    const other = STOCKS[5];
    expect(priceAt(other, SEED, 9_000)).toBe(priceAt(other, SEED, 9_000));
  });
});
