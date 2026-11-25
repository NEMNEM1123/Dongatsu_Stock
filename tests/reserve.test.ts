import { describe, expect, it } from "vitest";
import { firstTrigger, isClosing, isTriggered, parseReserve } from "../shared/reserve";

describe("예약 주문 조건", () => {
  it("이하·이상 조건", () => {
    expect(isTriggered("le", 100, 100)).toBe(true);
    expect(isTriggered("le", 100, 101)).toBe(false);
    expect(isTriggered("ge", 100, 100)).toBe(true);
    expect(isTriggered("ge", 100, 99)).toBe(false);
  });

  it("구간에서 처음 조건이 맞은 tick과 가격을 찾는다", () => {
    const prices = [105, 103, 99, 101, 98]; // tick 10..14
    expect(firstTrigger("le", 100, prices, 10, 9)).toEqual({ tick: 12, price: 99 });
    expect(firstTrigger("ge", 104, prices, 10, 9)).toEqual({ tick: 10, price: 105 });
    expect(firstTrigger("le", 90, prices, 10, 9)).toBeNull();
  });

  it("등록 tick 이전·같은 tick의 가격으로는 체결되지 않는다", () => {
    const prices = [99, 120, 99]; // tick 10..12
    expect(firstTrigger("le", 100, prices, 10, 10)).toEqual({ tick: 12, price: 99 }); // tick 10(등록 tick)은 건너뜀
    expect(firstTrigger("le", 100, prices, 10, 12)).toBeNull();
  });

  it("손절·익절 방향", () => {
    // 롱 손절: sell + le, 익절: sell + ge
    expect(firstTrigger("le", 95, [100, 96, 94], 1, 0)).toEqual({ tick: 3, price: 94 });
    expect(firstTrigger("ge", 110, [100, 109, 111], 1, 0)).toEqual({ tick: 3, price: 111 });
  });

  it("정리 주문 판별", () => {
    expect(isClosing("sell")).toBe(true);
    expect(isClosing("cover")).toBe(true);
    expect(isClosing("buy")).toBe(false);
    expect(isClosing("short")).toBe(false);
  });
});

describe("예약 입력 검사", () => {
  const ok = { stock: 1, action: "buy", qty: 10, leverage: 2, cond: "le", trigger: 1000 };

  it("올바른 입력", () => {
    const r = parseReserve(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ stock: 1, action: "buy", qty: 10, leverage: 2, cond: "le", trigger: 1000 });
  });

  it("매수가 아니면 레버리지는 1로 고정", () => {
    const r = parseReserve({ ...ok, action: "sell", leverage: 5 });
    expect(r.ok && r.value.leverage).toBe(1);
  });

  it("잘못된 값은 거부", () => {
    expect(parseReserve({ ...ok, action: "hack" }).ok).toBe(false);
    expect(parseReserve({ ...ok, qty: 0 }).ok).toBe(false);
    expect(parseReserve({ ...ok, qty: 1.5 }).ok).toBe(false);
    expect(parseReserve({ ...ok, cond: "eq" }).ok).toBe(false);
    expect(parseReserve({ ...ok, trigger: 10 }).ok).toBe(false); // 가격 하한 미만
    expect(parseReserve({ ...ok, trigger: 1000.5 }).ok).toBe(false);
    expect(parseReserve({ ...ok, trigger: "abc" }).ok).toBe(false);
    expect(parseReserve({ ...ok, leverage: 4 }).ok).toBe(false);
    expect(parseReserve({ ...ok, stock: "x" }).ok).toBe(false);
  });
});
