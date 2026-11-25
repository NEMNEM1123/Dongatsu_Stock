import type { Profile } from "./rules";

export interface StockDef {
  id: number; // 난수 입력으로 쓰이므로 한 번 정하면 바꾸지 않는다
  code: string;
  name: string;
  kind: "stock" | "coin";
  profile: Profile;
  basePrice: number; // 시작가 겸 되돌아가는 기준가 (원)
}

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
];

export function getStock(id: number): StockDef {
  const s = STOCKS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stock ${id}`);
  return s;
}
