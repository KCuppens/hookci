import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { installProgress } from "../src/db/install-progress";
import { setRepositorySelection, upsertInstallation } from "../src/db/installations";
import { tenantDb } from "../src/db/tenant";
import { installedPage, pickerPage } from "../src/pages/installed";
import { linkConfirmPage } from "../src/pages/link-confirm";
import { linkedPage } from "../src/pages/linked";
import { clearTables } from "./db/helpers";

const A = 7;
const B = 8;

async function addRepo(installation: number, id: number, name: string) {
  await env.DB.prepare("INSERT INTO repos (installation_id, repo_id, full_name, default_branch) VALUES (?1, ?2, ?3, 'main')")
    .bind(installation, id, name)
    .run();
}

beforeEach(clearTables);

describe("installProgress", () => {
  it("is empty for an installation with nothing set up", async () => {
    expect(await installProgress(tenantDb(env.DB, A))).toEqual({
      agentOnline: false,
      configured: false,
      bound: false,
      slackLinked: false,
      repoCount: 0,
      repoNames: [],
      repoSelection: null,
    });
  });

  it("reports the repository selection of its own installation only", async () => {
    await upsertInstallation(env.DB, { id: A, account_login: "a", account_type: "Organization", account_id: 1, created_at: 1 });
    await upsertInstallation(env.DB, { id: B, account_login: "b", account_type: "Organization", account_id: 2, created_at: 1 });
    await setRepositorySelection(env.DB, A, "selected");
    expect((await installProgress(tenantDb(env.DB, A))).repoSelection).toBe("selected");
    expect((await installProgress(tenantDb(env.DB, B))).repoSelection).toBeNull();
  });

  it("reads the steps and repositories of its own installation only", async () => {
    await env.DB.prepare(
      "INSERT INTO agents (agent_id, installation_id, name, credential_hash, paired_by_github_id, paired_at, status) VALUES ('a1', ?1, 'box', 'h1', 1, 1, 'online')",
    )
      .bind(A)
      .run();
    await env.DB.prepare("INSERT INTO workspace_links (team_id, installation_id, linked_by, created_at) VALUES ('T1', ?1, 'U1', 1)")
      .bind(A)
      .run();
    await env.DB.prepare("INSERT INTO repo_bindings (installation_id, repo_id, target, agent_id) VALUES (?1, 1, 'checks', 'a1')")
      .bind(A)
      .run();
    await env.DB.prepare(
      "INSERT INTO runs (run_id, installation_id, repo_id, sha, ref, event, attempt, trigger_id, state) VALUES ('r1', ?1, 1, 's', 'main', 'push', 1, 't', 'success')",
    )
      .bind(A)
      .run();
    await env.DB.prepare("INSERT INTO jobs (run_id, name, state) VALUES ('r1', '_config', 'success'), ('r1', 'build', 'success')").run();
    for (const [i, name] of ["z/last", "a/one", "b/two", "c/three", "d/four", "e/five", "f/six"].entries()) await addRepo(A, i + 1, name);
    await addRepo(B, 99, "other/secret");

    const p = await installProgress(tenantDb(env.DB, A));
    expect(p).toMatchObject({ agentOnline: true, configured: true, bound: true, slackLinked: true, repoCount: 7 });
    expect(p.repoNames).toEqual(["a/one", "b/two", "c/three", "d/four", "e/five"]);
    expect((await installProgress(tenantDb(env.DB, B))).agentOnline).toBe(false);
  });

  it("does not count a run that only produced the _config job", async () => {
    await env.DB.prepare(
      "INSERT INTO runs (run_id, installation_id, repo_id, sha, ref, event, attempt, trigger_id, state) VALUES ('r1', ?1, 1, 's', 'main', 'push', 1, 't', 'success')",
    )
      .bind(A)
      .run();
    await env.DB.prepare("INSERT INTO jobs (run_id, name, state) VALUES ('r1', '_config', 'success')").run();
    expect((await installProgress(tenantDb(env.DB, A))).configured).toBe(false);
  });
});

describe("flow pages escape names", () => {
  const evil = "<img src=x onerror=1>";
  const escaped = "&lt;img src=x onerror=1&gt;";

  it("installed page", async () => {
    const html = await (
      await installedPage({
        installationId: A,
        accountLogin: evil,
        accountType: "Organization",
        pairToken: "hc_pair_x",
        hubOrigin: "https://hub.test",
        latestAgentVersion: "1.2.3",
        expiresInMinutes: 15,
        progress: { agentOnline: false, configured: false, bound: false, slackLinked: false, repoCount: 1, repoNames: [evil], repoSelection: "selected" },
        cookies: [],
      })
    ).text();
    expect(html).not.toContain(evil);
    expect(html).toContain(escaped);
  });

  it("picker page", async () => {
    const html = await (await pickerPage([{ id: 1, accountLogin: evil }], [])).text();
    expect(html).not.toContain(evil);
    expect(html).toContain(escaped);
  });

  it("link pages", async () => {
    const confirm = await (await linkConfirmPage("t", evil, evil, "c=1")).text();
    expect(confirm).not.toContain(evil);
    expect(confirm).toContain(escaped);
    const done = await (await linkedPage(evil, evil, [])).text();
    expect(done).not.toContain(evil);
    expect(done).toContain(escaped);
  });
});

describe("flow page actions", () => {
  it("installed page offers a copy button per command, hidden until the script runs", async () => {
    const html = await (
      await installedPage({
        installationId: A,
        accountLogin: "roko",
        accountType: "Organization",
        pairToken: "hc_pair_x",
        hubOrigin: "https://hub.test",
        latestAgentVersion: "1.2.3",
        expiresInMinutes: 15,
        progress: { agentOnline: false, configured: false, bound: false, slackLinked: false, repoCount: 0, repoNames: [], repoSelection: "selected" },
        cookies: [],
      })
    ).text();
    expect(html).toContain("<pre>curl -fsSL https://hub.test/install | sh -s -- hc_pair_x</pre>");
    expect(html.match(/<button type="button" class="cp" data-copy data-copied="Copied" hidden>Copy<\/button>/g)).toHaveLength(3);
    expect(html).toContain("navigator.clipboard.writeText");
    expect(html).not.toMatch(/style="/);
  });

  it("installed page references only icon symbols the page defines", async () => {
    const html = await (
      await installedPage({
        installationId: A,
        accountLogin: "roko",
        accountType: "Organization",
        pairToken: "hc_pair_x",
        hubOrigin: "https://hub.test",
        latestAgentVersion: "1.2.3",
        expiresInMinutes: 15,
        progress: { agentOnline: true, configured: true, bound: true, slackLinked: true, repoCount: 12, repoNames: ["roko-api"], repoSelection: "selected" },
        cookies: [],
      })
    ).text();
    const used = new Set([...html.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
    expect(used).toContain("i-repo-tile");
    expect(used).toContain("i-book-open");
    expect(used).toContain("i-chat-bubble");
    expect(used).toContain("i-ext-box");
    for (const id of used) expect(html).toContain(`id="${id}"`);
  });

  it("link confirm names who is being linked and requires a POST", async () => {
    const html = await (await linkConfirmPage("tok", "Roko Home Services", "U08F3H2JK", "c=1")).text();
    expect(html).toContain("Roko Home Services");
    expect(html).toContain("U08F3H2JK");
    expect(html).toMatch(/<form[^>]*method="post"/i);
  });

  it("link confirm references only glyph symbols it defines and carries no inline style", async () => {
    const html = await (await linkConfirmPage("tok", "Roko Home Services", "U08F3H2JK", "c=1")).text();
    const used = [...html.matchAll(/<use [^>]*href="#([^"]+)"/g)].map((m) => m[1]);
    expect(used).toContain("cg-gh");
    for (const id of used) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/\sstyle="/);
  });
});
