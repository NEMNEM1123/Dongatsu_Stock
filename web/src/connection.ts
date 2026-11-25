import type { ClientMsg, ServerMsg } from "../../shared/protocol";
import { CLIENT_VERSION } from "../../shared/version";
import { clock } from "./clock";

export type ConnStatus = "connecting" | "open" | "closed";

const PING_INTERVAL_MS = 30_000;
const BURST_PINGS = 4; // 연결 직후 빠르게 여러 번 재서 offset을 안정시킨다
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 30_000;

/** WebSocket 연결. 끊기면 지수 백오프로 자동 재연결하고, 재연결하면 서버가 hello로 상태를 다시 보낸다. */
export class Connection {
  status: ConnStatus = "closed";
  onStatus: (s: ConnStatus) => void = () => {};
  onMessage: (m: ServerMsg) => void = () => {};
  onFatal: (code: number) => void = () => {}; // 재연결해도 소용없는 종료 (정지 등)

  private ws: WebSocket | null = null;
  private backoff = BACKOFF_MIN;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private pending = new Map<number, number>(); // 보낸 클라이언트 시각 → 같은 값(식별용)
  private stopped = true;

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }

  /** 보냈으면 true. 연결이 열려 있지 않으면 보내지 않고 false (호출한 쪽이 알 수 있게). */
  send(m: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  private setStatus(s: ConnStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?v=${CLIENT_VERSION}`);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = BACKOFF_MIN;
      this.setStatus("open");
      for (let i = 0; i < BURST_PINGS; i++) setTimeout(() => this.ping(), i * 300);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      const t1 = Date.now();
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === "pong") {
        if (this.pending.delete(m.c)) clock.addSample(m.c, t1, m.s);
        return;
      }
      if (m.t === "hello") {
        // 첫 샘플: 지연을 알 수 없으므로 서버 시각만 대략 반영 (이후 pong 샘플이 덮어씀)
        if (clock.offset === 0) clock.offset = m.serverNow - t1;
      }
      this.onMessage(m);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.pending.clear();
      this.setStatus("closed");
      if (this.stopped) return;
      if (ev.code === 4001) {
        this.stopped = true;
        this.onFatal(ev.code);
        return;
      }
      this.retryTimer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    };
  }

  private ping(): void {
    // 같은 ms에 두 번 보내도 구분되도록 소수 가산 없이 겹치면 건너뜀
    const c = Date.now();
    if (this.pending.has(c)) return;
    this.pending.set(c, c);
    this.send({ t: "ping", c });
  }
}
