import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSinkConfig, disableSinkConfig, type SinkConfigRow } from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import type { Env } from "../../src/env";
import { sinksFor, sinksForRun } from "../../src/sinks";
import "../../src/sinks/checks";
import type { OutboxItem } from "../../src/sinks/deliverers";
import { OutboxSink } from "../../src/sinks/outbox-sink";
import "../../src/sinks/slack";
import type { RunState, RunView } from "../../src/sinks/types";
import { clearTables } from "../db/helpers";

const INSTALLATION = 51;
const TARGET = "https://hooks.example/secret-path";
const t = tenantDb(env.DB, INSTALLATION);

let cfg: SinkConfigRow;

beforeEach(async () => {
  await clearTables();
  cfg = await createSinkConfig(env, t, { kind: "webhook", repo: "org/api", target: TARGET, secret: "whsec-secret", createdBy: "slack:T1:U1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function view(state: RunState): RunView {
  return {
    installationId: INSTALLATION,
    repoId: 1,
    repo: "org/api",
    triggerId: "trg_1",
    runId: "run_1",
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    event: "push",
    target: "main",
    state,
    commitTitle: "Fix the build",
    authorLogin: "dev",
    jobs: [],
  };
}

/** env with SINK_OUTBOX replaced by one whose stubs call enqueue, recording the outbox name each went to. */
function withOutbox(enqueue: (item: OutboxItem) => Promise<void>): { env: Env; names: string[] } {
  const names: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return name;
    },
    get: () => ({ enqueue }),
  };
  return { env: { ...env, SINK_OUTBOX: namespace } as unknown as Env, names };
}

describe("OutboxSink", () => {
  it("queues the run on its sink's outbox, keyed by trigger id", async () => {
    const items: OutboxItem[] = [];
    const fake = withOutbox(async (item) => {
      items.push(item);
    });
    const sink = new OutboxSink(fake.env, INSTALLATION, cfg);

    await sink.onRunUpdate(view("running"));
    await sink.onJobUpdate(view("failed"));

    expect(sink.name).toBe(`outbox:webhook:${cfg.id}`);
    expect(fake.names).toEqual([`${INSTALLATION}:${cfg.id}`, `${INSTALLATION}:${cfg.id}`]);
    expect(items.map((i) => [i.installationId, i.sinkId, i.runId, i.terminal, i.payload.state])).toEqual([
      [INSTALLATION, cfg.id, "trg_1", false, "running"],
      [INSTALLATION, cfg.id, "trg_1", true, "failed"],
    ]);
  });

  it("resolves when the outbox throws, and logs neither target nor secret", async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => logged.push(args));
    vi.spyOn(console, "log").mockImplementation((...args) => logged.push(args));
    const sink = new OutboxSink(
      withOutbox(async () => {
        throw new Error("Durable Object reset");
      }).env,
      INSTALLATION,
      cfg,
    );

    await expect(sink.onRunUpdate(view("running"))).resolves.toBeUndefined();

    expect(logged.length).toBeGreaterThan(0);
    const output = JSON.stringify(logged);
    expect(output).not.toContain(TARGET);
    expect(output).not.toContain("whsec-secret");
  });
});

describe("sinksForRun", () => {
  it("adds one outbox sink per enabled config of the repo to the installation's sinks", async () => {
    const telegram = await createSinkConfig(env, t, { kind: "telegram", repo: "org/api", target: "-100", secret: "bot", createdBy: "slack:T1:U1" });
    const disabled = await createSinkConfig(env, t, { kind: "webhook", repo: "org/api", target: TARGET, secret: null, createdBy: "slack:T1:U1" });
    await disableSinkConfig(t, disabled.id, "webhook_gone", 1);
    await createSinkConfig(env, t, { kind: "webhook", repo: "org/web", target: TARGET, secret: null, createdBy: "slack:T1:U1" });
    await createSinkConfig(env, tenantDb(env.DB, INSTALLATION + 1), { kind: "webhook", repo: "org/api", target: TARGET, secret: null, createdBy: "slack:T2:U2" });

    const base = (await sinksFor(env, INSTALLATION)).map((s) => s.name);
    const names = (await sinksForRun(env, INSTALLATION, "org/api")).map((s) => s.name);

    expect(base).toEqual(expect.arrayContaining(["slack", "checks"]));
    expect(names).toHaveLength(base.length + 2);
    expect(names.slice(0, base.length)).toEqual(base);
    expect(new Set(names.slice(base.length))).toEqual(new Set([`outbox:webhook:${cfg.id}`, `outbox:telegram:${telegram.id}`]));
    expect((await sinksForRun(env, INSTALLATION, "org/other")).map((s) => s.name)).toEqual(base);
  });
});
