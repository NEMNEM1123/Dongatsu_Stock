import type { Profile } from "./rules";

export interface StockDef {
  id: number; // 난수 입력으로 쓰이므로 한 번 정하면 바꾸지 않는다
  code: string;
  name: string; // 임시 이름 — 사용자가 채움
  kind: "stock" | "coin";
  profile: Profile;
  basePrice: number; // 시작가 겸 되돌아가는 기준가 (원)
}

export const STOCKS: readonly StockDef[] = [
  { id: 1, code: "S01", name: "임시종목 1", kind: "stock", profile: "stable", basePrice: 50_000 },
  { id: 2, code: "S02", name: "임시종목 2", kind: "stock", profile: "stable", basePrice: 82_000 },
  { id: 3, code: "S03", name: "임시종목 3", kind: "stock", profile: "stable", basePrice: 31_500 },
  { id: 4, code: "S04", name: "임시종목 4", kind: "stock", profile: "normal", basePrice: 24_000 },
  { id: 5, code: "S05", name: "임시종목 5", kind: "stock", profile: "normal", basePrice: 67_000 },
  { id: 6, code: "S06", name: "임시종목 6", kind: "stock", profile: "normal", basePrice: 15_800 },
  { id: 7, code: "S07", name: "임시종목 7", kind: "stock", profile: "normal", basePrice: 123_000 },
  { id: 8, code: "S08", name: "임시종목 8", kind: "stock", profile: "volatile", basePrice: 9_500 },
  { id: 9, code: "S09", name: "임시종목 9", kind: "stock", profile: "volatile", basePrice: 42_000 },
  { id: 10, code: "S10", name: "임시종목 10", kind: "stock", profile: "volatile", basePrice: 18_000 },
  { id: 101, code: "C01", name: "임시코인 1", kind: "coin", profile: "coin", basePrice: 100_000 },
  { id: 102, code: "C02", name: "임시코인 2", kind: "coin", profile: "coin", basePrice: 5_000 },
  { id: 103, code: "C03", name: "임시코인 3", kind: "coin", profile: "coin", basePrice: 800 },
];

export function getStock(id: number): StockDef {
  const s = STOCKS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stock ${id}`);
  return s;
}
