import { env } from "cloudflare:workers";

export interface FakeAgentNamespace {
  /** Agent ids each `/revoke` was sent to, in order. */
  revoked: string[];
  restore(): void;
}

/** Swaps env.AGENT_DO for a stub; `/status` answers online, or never when hang is set. */
export function fakeAgentNamespace(opts: { hang?: boolean }): FakeAgentNamespace {
  const saved = env.AGENT_DO;
  const revoked: string[] = [];
  const stub = (agentId: string) => ({
    async fetch(input: string): Promise<Response> {
      const path = new URL(input).pathname;
      if (path === "/revoke") {
        revoked.push(agentId);
        return Response.json({ ok: true });
      }
      if (path === "/status") {
        if (opts.hang) return new Promise<Response>(() => {});
        return Response.json({ online: true, last_seen_at: 1, protocol: 1, agent_version: "0.1.0" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  env.AGENT_DO = { idFromName: (name: string) => name, get: (id: string) => stub(id) } as unknown as typeof env.AGENT_DO;
  return {
    revoked,
    restore() {
      env.AGENT_DO = saved;
    },
  };
}
