import { describe, expect, it } from "vitest";
import { nextReload, RELOAD_DELAYS_MS } from "../web/src/reload";

describe("자동 새로고침", () => {
  it("같은 버전은 정해진 횟수까지만 시도한다", () => {
    let record: string | null = null;
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const next = nextReload(record, "2.0.0");
      if (!next) break;
      delays.push(next.delayMs);
      record = next.record;
    }
    expect(delays).toEqual(RELOAD_DELAYS_MS);
  });

  it("다른 버전이 나오면 처음부터 다시 시도한다", () => {
    expect(nextReload("2.0.0 3", "2.0.1")).toEqual({ delayMs: RELOAD_DELAYS_MS[0], record: "2.0.1 1" });
  });

  it("예전 방식의 기록은 한 번 시도한 것으로 본다", () => {
    expect(nextReload("2.0.0", "2.0.0")).toEqual({ delayMs: RELOAD_DELAYS_MS[1], record: "2.0.0 2" });
  });
});
