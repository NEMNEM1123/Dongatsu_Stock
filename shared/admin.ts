// 관리자 도구의 입력 검사 (순수 함수). 권한 확인은 서버가 따로 한다.

import { RULES } from "./rules";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** 전체 공지 문구: 앞뒤 공백을 뺀 1~ANNOUNCE_MAX_LEN자 */
export function parseAnnounce(raw: unknown): Parsed<string> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, error: "공지 내용을 입력하세요." };
  if (text.length > RULES.ANNOUNCE_MAX_LEN) return { ok: false, error: `공지는 ${RULES.ANNOUNCE_MAX_LEN}자까지입니다.` };
  return { ok: true, value: text };
}

export type CashMode = "set" | "add";

/** 현금 조정 결과를 계산한다. set은 그 금액으로 지정, add는 더하기(음수면 빼기). 결과는 0 이상 ADMIN_CASH_MAX 이하여야 한다. */
export function adjustCash(current: number, mode: unknown, amount: unknown): Parsed<number> {
  if (mode !== "set" && mode !== "add") return { ok: false, error: "알 수 없는 작업입니다." };
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) return { ok: false, error: "금액은 정수로 입력하세요." };
  const next = mode === "set" ? amount : current + amount;
  if (next < 0) return { ok: false, error: "현금은 0원보다 적을 수 없습니다." };
  if (next > RULES.ADMIN_CASH_MAX) return { ok: false, error: `현금은 ${RULES.ADMIN_CASH_MAX.toLocaleString("ko-KR")}원까지입니다.` };
  return { ok: true, value: next };
}
