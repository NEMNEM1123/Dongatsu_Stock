import { describe, expect, it } from "vitest";
import { bestOffset, makeSample } from "../web/src/clock";

describe("시각 동기화", () => {
  it("왕복 지연의 절반을 보정해 offset 계산", () => {
    // 클라이언트 시계가 서버보다 5초 느리고, 왕복 200ms (한 방향 100ms)
    const s = makeSample(1000, 1200, 6100); // 서버는 클라 시각 1100(=6100-5000) 시점에 응답
    expect(s.rtt).toBe(200);
    expect(s.offset).toBe(5000);
  });

  it("왕복이 가장 짧은 샘플을 채택", () => {
    const samples = [makeSample(0, 400, 5300), makeSample(1000, 1040, 6020), makeSample(2000, 2300, 7100)];
    expect(bestOffset(samples)).toBe(5000);
  });
});
