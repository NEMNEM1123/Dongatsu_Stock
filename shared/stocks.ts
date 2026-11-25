import { RULES, type Profile } from "./rules";

export interface StockDef {
  id: number; // 난수 입력으로 쓰이므로 한 번 정하면 바꾸지 않는다
  code: string;
  name: string;
  kind: "stock" | "coin" | "etf";
  profile: Profile; // ETF는 쓰지 않는다 (자체 가격 변동이 없다)
  basePrice: number; // 시작가 겸 되돌아가는 기준가 (원). ETF는 구성 종목이 모두 기준가일 때의 가격
  components?: readonly { id: number; weight: number }[]; // ETF 구성 종목과 비중
}

const eq = (...ids: number[]): { id: number; weight: number }[] => ids.map((id) => ({ id, weight: 1 }));

export const STOCKS: readonly StockDef[] = [
  { id: 1, code: "S01", name: "양호재의 초울트라 레전드 양호재급 돈까스", kind: "stock", profile: "stable", basePrice: 50_000 },
  { id: 2, code: "S02", name: "최종학의 스핑크스 돈까스", kind: "stock", profile: "stable", basePrice: 82_000 },
  { id: 3, code: "S03", name: "백경열의 실버 돈까스", kind: "stock", profile: "stable", basePrice: 31_500 },
  { id: 4, code: "S04", name: "이병권의 외이도염 돈까스", kind: "stock", profile: "normal", basePrice: 24_000 },
  { id: 5, code: "S05", name: "조현수의 기흉 돈까스", kind: "stock", profile: "normal", basePrice: 67_000 },
  { id: 6, code: "S06", name: "엄현우의 대상포진 돈까스", kind: "stock", profile: "normal", basePrice: 15_800 },
  { id: 7, code: "S07", name: "김릉환의 블루 돈까스", kind: "stock", profile: "normal", basePrice: 123_000 },
  { id: 8, code: "S08", name: "송정근의 세리 돈까스", kind: "stock", profile: "volatile", basePrice: 9_500 },
  { id: 9, code: "S09", name: "장지윤의 고양이 돈가스", kind: "stock", profile: "volatile", basePrice: 42_000 },
  { id: 10, code: "S10", name: "늑대사냥꾼 돈까스", kind: "stock", profile: "volatile", basePrice: 18_000 },
  { id: 11, code: "S11", name: "복동원의 쇠구슬 돈가스", kind: "stock", profile: "stable", basePrice: 45_000 },
  { id: 12, code: "S12", name: "오현우의 게이 돈가스", kind: "stock", profile: "normal", basePrice: 28_000 },
  { id: 13, code: "S13", name: "김릉환의 쿠팡 알바 돈가스", kind: "stock", profile: "normal", basePrice: 12_000 },
  { id: 14, code: "S14", name: "이기열의 오도짜세 기열 돈가스", kind: "stock", profile: "volatile", basePrice: 33_000 },
  { id: 101, code: "C01", name: "김성준의 프로틴 돈까스 코인", kind: "coin", profile: "coin", basePrice: 100_000 },
  { id: 102, code: "C02", name: "오현우의 경영식 ESG 치킨까스 코인", kind: "coin", profile: "coin", basePrice: 5_000 },
  { id: 103, code: "C03", name: "정진우의 67점 덩크 돈까스 코인", kind: "coin", profile: "coin", basePrice: 800 },
  { id: 104, code: "C04", name: "조현수의 롯데리아 돈가스 코인", kind: "coin", profile: "coin", basePrice: 3_000 },
  { id: 105, code: "C05", name: "김릉환의 해병 돈가스 코인", kind: "coin", profile: "coin", basePrice: 20_000 },
  { id: 106, code: "C06", name: "조현수의 예비 6767번 돈가스 코인", kind: "coin", profile: "coin", basePrice: 6_767 },
  // ETF: 구성 종목의 (현재가 ÷ 기준가)를 비중대로 평균해 ETF 시작가에 곱한 값. 자체 난수가 없고 구성 종목이 움직이는 대로 따라간다.
  { id: 201, code: "E01", name: "돈까스 종합 ETF", kind: "etf", profile: "stable", basePrice: 50_000, components: eq(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14) },
  { id: 202, code: "E02", name: "안정형 돈까스 ETF", kind: "etf", profile: "stable", basePrice: 50_000, components: eq(1, 2, 3, 11) },
  { id: 203, code: "E03", name: "고변동 돈까스 ETF", kind: "etf", profile: "stable", basePrice: 30_000, components: eq(8, 9, 10, 14) },
  { id: 204, code: "E04", name: "돈까스 코인 ETF", kind: "etf", profile: "stable", basePrice: 10_000, components: eq(101, 102, 103, 104, 105, 106) },
];

/** ETF 가격: 구성 종목의 (현재가 ÷ 기준가)를 비중대로 평균해 ETF 시작가에 곱한다. 정수(원), 하한가 적용. */
export function etfPrice(def: StockDef, priceOf: (id: number) => number): number {
  const comps = def.components;
  if (!comps || comps.length === 0) throw new Error(`not an etf: ${def.id}`);
  let sum = 0;
  let weights = 0;
  for (const c of comps) {
    sum += (c.weight * priceOf(c.id)) / getStock(c.id).basePrice;
    weights += c.weight;
  }
  return Math.max(RULES.PRICE_FLOOR, Math.round((def.basePrice * sum) / weights));
}

export function getStock(id: number): StockDef {
  const s = STOCKS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stock ${id}`);
  return s;
}
