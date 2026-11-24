import type { MaintenanceInfo, UserInfo } from "../../shared/protocol";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, message: data.error ?? "요청에 실패했습니다." };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, message: "서버에 연결할 수 없습니다." };
  }
}

/** 관리자 API 호출 (쿠키로 인증, 서버가 관리자 권한을 확인한다) */
export const adminCall = <T = { ok: true }>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> => call<T>(method, path, body);

export const api = {
  status: () => call<{ maintenance: MaintenanceInfo; minVersion: number }>("GET", "/api/status"),
  me: () => call<{ user: UserInfo | null }>("GET", "/api/me"),
  login: (nickname: string, password: string) =>
    call<{ user: UserInfo }>("POST", "/api/login", { nickname, password }),
  register: (nickname: string, password: string) =>
    call<{ user: UserInfo }>("POST", "/api/register", { nickname, password }),
  logout: () => call<{ ok: true }>("POST", "/api/logout"),
};
