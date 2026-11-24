export type ToastKind = "info" | "up" | "down" | "warn";

export function toast(message: string, kind: ToastKind = "info", ms = 3000): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind === "info" ? "" : kind}`.trim();
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
