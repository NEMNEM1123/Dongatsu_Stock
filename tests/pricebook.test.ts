import { describe, expect, it } from "vitest";
import { CLIENT_VERSION, MIN_CLIENT_VERSION } from "../shared/version";
import { STOCKS } from "../shared/stocks";
import { PriceBook } from "../web/src/pricebook";

const days = (ids: number[]) => ids.map((stock) => ({ stock, day: 0, open: 1, high: 1, low: 1, volume: 0 }));
const ids = STOCKS.map((s) => s.id);

describe("가격 장부", () => {
  it("서버가 알려 준 종목 순서(ids)대로 가격을 짝짓는다", () => {
    const b = new PriceBook();
    const order = [...ids].reverse(); // 이 화면의 STOCKS 순서와 일부러 다르게
    b.init(0, 2000, 1, { tick: 10, p: order.map((id) => id * 10), ids: order }, days(order));
    for (const id of ids) expect(b.priceNow(id)).toBe(id * 10);
    b.onPx(11, order.map((id) => id * 10 + 1));
    for (const id of ids) expect(b.priceNow(id)).toBe(id * 10 + 1);
  });

  it("ids가 없으면 이 화면의 STOCKS 순서를 쓴다 (예전 서버)", () => {
    const b = new PriceBook();
    b.init(0, 2000, 1, { tick: 10, p: ids.map((id) => id + 5) }, days(ids));
    for (const id of ids) expect(b.priceNow(id)).toBe(id + 5);
  });

  it("이 화면이 모르는 종목이 와도 문제없고, 아는 종목 가격은 정확함", () => {
    const b = new PriceBook();
    const order = [999, ...ids];
    b.init(0, 2000, 1, { tick: 10, p: order.map((id) => id * 2), ids: order }, days(order));
    expect(b.priceNow(999)).toBe(1998);
    for (const id of ids) expect(b.priceNow(id)).toBe(id * 2);
  });

  it("값이 비거나 숫자가 아니면 0으로 덮지 않고 이전 가격을 유지", () => {
    const b = new PriceBook();
    b.init(0, 2000, 1, { tick: 10, p: ids.map(() => 100), ids }, days(ids));
    const bad = ids.map((_, i) => (i === 0 ? null : 200)) as unknown as number[];
    b.onPx(11, bad);
    expect(b.priceNow(ids[0]!)).toBe(100); // 값이 없던 종목은 그대로
    expect(b.priceNow(ids[1]!)).toBe(200);
  });

  it("재접속(init)하면 이전 연결의 가격이 남지 않음", () => {
    const b = new PriceBook();
    b.init(0, 2000, 1, { tick: 10, p: ids.map(() => 100), ids }, days(ids));
    b.init(0, 2000, 1, { tick: 20, p: [5], ids: [ids[0]!] }, days([ids[0]!]));
    expect(b.priceNow(ids[0]!)).toBe(5);
    expect(b.priceNow(ids[1]!)).toBe(0);
  });
});

describe("버전 하한선", () => {
  it("현재 화면은 서버의 하한선 이상이어야 한다 (아니면 배포 직후 자기 자신이 막힌다)", () => {
    expect(CLIENT_VERSION).toBeGreaterThanOrEqual(MIN_CLIENT_VERSION);
    expect(MIN_CLIENT_VERSION).toBeGreaterThanOrEqual(2); // 종목 추가로 가격 배열 순서가 바뀐 배포 이후
  });
});
