import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateFor } from "../../src/checks/map";
import { bind } from "../../src/db/bindings";
import { tenantDb } from "../../src/db/tenant";
import { TRUST_REFUSAL_TEXT, type TrustRefusal } from "../../src/policy/trust";
import type { RunView } from "../../src/sinks/types";
import { INSTALLATION, REPO } from "../commands-helpers";
import { BASE_SHA, deliver, type ForkWorld, forkPush, HEAD_SHA, outbox, POLICY_FILE, runs, setUpForkWorld } from "../forks/world";

let world: ForkWorld;
const savedMode = env.HUB_MODE;

beforeEach(async () => {
  world = await setUpForkWorld();
  // The fork's own .zeroci.yml always asks for trust: all; only the base ref may grant it.
  world.files[`${REPO.full_name}@${HEAD_SHA}:.zeroci.yml`] = "checks:\n  trust: all\n";
});

afterEach(() => {
  env.HUB_MODE = savedMode;
  world.restore();
  vi.restoreAllMocks();
});

function lastRunView(): RunView {
  const run = world.sink.calls.flatMap((c) => (c.op === "onRunUpdate" ? [c.run] : [])).at(-1);
  if (!run) throw new Error("no run update reached the sinks");
  return run;
}

function forkPr(authorAssociation: string) {
  const payload = forkPush();
  return { ...payload, pull_request: { ...payload.pull_request, author_association: authorAssociation } };
}

interface Case {
  mode: "shared" | "self_hosted";
  trust: "collaborators" | "all";
  forks: "gated" | "never";
  deploy: boolean;
  author: "COLLABORATOR" | "NONE";
}

const CASES: Case[] = [];
for (const mode of ["shared", "self_hosted"] as const)
  for (const trust of ["collaborators", "all"] as const)
    for (const forks of ["gated", "never"] as const)
      for (const deploy of [false, true])
        for (const author of ["COLLABORATOR", "NONE"] as const) CASES.push({ mode, trust, forks, deploy, author });

function refusal(c: Case): TrustRefusal | null {
  if (c.trust !== "all") return null;
  if (c.mode === "shared") return "shared_hub";
  return c.deploy ? "deploy_bindings" : null;
}

describe("fork pull request gating by HUB_MODE and the base ref's trust", () => {
  it.each(CASES)("$mode hub, trust: $trust, forks: $forks, deploy binding $deploy, author $author", async (c) => {
    env.HUB_MODE = c.mode;
    world.files[POLICY_FILE] = `checks:\n  trust: ${c.trust}\n  forks: ${c.forks}\n`;
    if (c.deploy) await bind(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "deploy:production", world.agent.agentId);

    await deliver("pull_request", forkPr(c.author));

    expect(world.refs).toEqual([BASE_SHA]);
    const triggers = (await outbox(world.agent)).filter((f) => f.type === "trigger");
    const [row] = await runs();
    if (c.mode === "self_hosted" && c.trust === "all" && !c.deploy && c.forks === "gated") {
      expect(triggers).toEqual([expect.objectContaining({ sha: HEAD_SHA, trust: "untrusted" })]);
      expect(row).toMatchObject({ state: "queued", reason: null, trust_refused: null });
      return;
    }

    expect(triggers).toEqual([]);
    const reason = c.forks === "never" ? "fork_never" : "fork_gated";
    const refused = refusal(c);
    expect(row).toMatchObject({ state: "gated", reason, trust_refused: refused });
    const check = aggregateFor(lastRunView(), "https://hub.test");
    expect(check).toMatchObject({ status: "completed", conclusion: "action_required" });
    if (refused) expect(check.summary).toContain(TRUST_REFUSAL_TEXT[refused]);
    else expect(check.summary).not.toContain("trust: all");
    if (reason === "fork_gated") expect(check.actions).toEqual([expect.objectContaining({ identifier: "approve_run" })]);
    else expect(check.actions).toBeUndefined();
  });

  it("logs trust_all_refused when the shared hub refuses trust: all", async () => {
    const log = vi.spyOn(console, "log");
    env.HUB_MODE = "shared";
    world.files[POLICY_FILE] = "checks:\n  trust: all\n";

    await deliver("pull_request", forkPush());

    expect(log.mock.calls.map(([l]) => JSON.parse(String(l)))).toContainEqual(
      expect.objectContaining({ event: "trust_all_refused", repo: REPO.full_name, refused: "shared_hub" }),
    );
  });

  it("treats an unknown HUB_MODE as the shared hub", async () => {
    env.HUB_MODE = "selfhosted";
    world.files[POLICY_FILE] = "checks:\n  trust: all\n";

    await deliver("pull_request", forkPush());

    expect((await outbox(world.agent)).filter((f) => f.type === "trigger")).toEqual([]);
    expect(await runs()).toEqual([expect.objectContaining({ state: "gated", reason: "fork_gated", trust_refused: "shared_hub" })]);
  });
});
