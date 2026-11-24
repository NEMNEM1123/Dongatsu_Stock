// 비밀번호 해시, 세션 토큰, 입력 검증

const PBKDF2_ITERATIONS = 100_000; // Workers 허용 최대값
const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashPassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toHex(bits);
}

export function newSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 세션 토큰: 쿠키에는 원본, DB에는 SHA-256 해시만 저장 */
export function newToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** [0, n) 균등 난수. 모듈로 편향이 없도록 범위 밖 값은 버리고 다시 뽑는다. */
export function randomBelow(n: number): number {
  const limit = 0x100000000 - (0x100000000 % n);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

// ── 입력 검증 ──

// 간단한 욕설 목록 (소문자 비교, 숫자·밑줄 제거 후 부분 일치). 필요하면 추가.
const BAD_WORDS = ["시발", "씨발", "병신", "개새끼", "지랄", "fuck", "shit", "admin", "운영자", "관리자"];

export function validateNickname(nick: unknown): string | null {
  if (typeof nick !== "string") return "닉네임을 입력하세요.";
  const n = nick.trim();
  const len = [...n].length;
  if (len < 2 || len > 12) return "닉네임은 2~12자여야 합니다.";
  if (!/^[0-9A-Za-z_가-힣]+$/.test(n)) return "닉네임은 한글, 영문, 숫자, _ 만 쓸 수 있습니다.";
  const flat = n.toLowerCase().replace(/[_0-9]/g, "");
  if (BAD_WORDS.some((w) => flat.includes(w))) return "사용할 수 없는 닉네임입니다.";
  return null;
}

export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== "string") return "비밀번호를 입력하세요.";
  if (pw.length < 6 || pw.length > 64) return "비밀번호는 6~64자여야 합니다.";
  return null;
}
