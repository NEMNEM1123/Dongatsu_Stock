import { Market, type Env } from "./market";

export { Market };
export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      // 게임 상태는 Market 하나가 전부 처리한다
      const stub = env.MARKET.get(env.MARKET.idFromName("main"));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
