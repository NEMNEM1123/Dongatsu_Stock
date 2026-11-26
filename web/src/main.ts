import "../styles/tokens.css";
import "../styles/app.css";
import type { UserInfo } from "../../shared/protocol";
import { api } from "./api";
import { mountApp } from "./app";
import { el } from "./dom";
import { hideOverlay, showOverlay } from "./overlay";
import { watchForNewVersion } from "./reload";
import { CLIENT_VERSION } from "../../shared/version";
import { toast } from "./toast";

const root = document.getElementById("app")!;
let unmount: (() => void) | null = null;

// ── 로그인 화면 ──
function showLogin(): void {
  unmount?.();
  unmount = null;
  let mode: "login" | "register" = "login";

  const nick = el("input", { class: "input", placeholder: "닉네임 (2~12자)", maxLength: 12, autocomplete: "username" });
  const pw = el("input", { class: "input", type: "password", placeholder: "비밀번호 (6자 이상)", autocomplete: "current-password" });
  const submit = el("button", { class: "btn btn-primary btn-lg", type: "submit" });
  const switchBtn = el("button", { class: "link-btn", type: "button" });

  const render = () => {
    submit.textContent = mode === "login" ? "로그인" : "회원가입";
    switchBtn.textContent = mode === "login" ? "계정이 없나요? 회원가입" : "이미 계정이 있나요? 로그인";
    pw.autocomplete = mode === "login" ? "current-password" : "new-password";
  };
  render();
  switchBtn.onclick = () => {
    mode = mode === "login" ? "register" : "login";
    render();
  };

  const form = el("form", { class: "panel login-panel" }, el("div", { class: "login-logo" }, "돈까스거래소"), nick, pw, submit, switchBtn);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    const r = mode === "login" ? await api.login(nick.value, pw.value) : await api.register(nick.value, pw.value);
    submit.disabled = false;
    if (!r.ok) return toast(r.message, "warn");
    showApp(r.data.user);
  };

  root.replaceChildren(el("div", { class: "login-wrap" }, form));
  nick.focus();
  api.status().then((s) => {
    if (!s.ok || !s.data.maintenance.on) return;
    const msg = s.data.maintenance.message;
    form.insertBefore(el("div", { class: "warn-text login-notice" }, `점검 중입니다${msg ? `: ${msg}` : ""}`), form.children[1] ?? null);
  });
}

function showApp(user: UserInfo): void {
  unmount?.();
  unmount = mountApp(root, user, async () => {
    unmount?.();
    unmount = null;
    await api.logout();
    showLogin();
  });
}

watchForNewVersion(); // 로그인 전 화면에서도 새 버전이 배포되면 새로고침한다

(async () => {
  // 로그인 전에도 새 버전·점검 상태를 확인한다
  const st = await api.status();
  if (st.ok && CLIENT_VERSION < st.data.minVersion) {
    showOverlay("새 버전이 나왔습니다", "원활한 이용을 위해 페이지를 새로고침해 주세요.", { label: "새로고침", run: () => location.reload() });
    return;
  }
  hideOverlay();
  const r = await api.me();
  if (r.ok && r.data.user) showApp(r.data.user);
  else showLogin();
})();
