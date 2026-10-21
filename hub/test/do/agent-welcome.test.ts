import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { agentVersions } from "../../src/version";
import { clearTables } from "../db/helpers";
import { connect, seedAgent } from "./agent-socket";

const INSTALLATION = 42;

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
});

describe("welcome agent versions", () => {
  it("sends latest_agent_version and min_agent_version from the vars", async () => {
    const sock = await connect(await seedAgent(INSTALLATION));
    const welcome = await sock.hello();
    expect(welcome.type).toBe("welcome");
    expect(welcome.latest_agent_version).toBe("v0.3.0");
    expect(welcome.min_agent_version).toBe("v0.1.0");
    sock.ws.close();
  });

  it("leaves out a field whose var is empty", () => {
    expect(agentVersions({ LATEST_AGENT_VERSION: "v0.3.0", MIN_AGENT_VERSION: "" })).toEqual({ latest_agent_version: "v0.3.0" });
    expect(agentVersions({ LATEST_AGENT_VERSION: "", MIN_AGENT_VERSION: "" })).toEqual({});
  });
});
