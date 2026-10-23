import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createSinkConfig, disableSinkConfig, getSinkConfigWithSecret, getSinkMessage, listSinkConfigs, putSinkMessage, type SinkConfigRow } from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import { clearTables } from "./helpers";

const a = tenantDb(env.DB, 1);
const b = tenantDb(env.DB, 2);
let cfgA: SinkConfigRow;
let cfgB: SinkConfigRow;

beforeEach(async () => {
  await clearTables();
  cfgA = await createSinkConfig(env, a, { kind: "telegram", repo: "org/api", target: "-1001", secret: "token-a", createdBy: "slack:TA:UA" });
  cfgB = await createSinkConfig(env, b, { kind: "telegram", repo: "org/api", target: "-1002", secret: "token-b", createdBy: "slack:TB:UB" });
});

describe("sink config isolation", () => {
  it("never lists, reads or disables another installation's config", async () => {
    expect(await listSinkConfigs(a)).toEqual([cfgA]);
    expect(await listSinkConfigs(a, "org/api")).toEqual([cfgA]);
    expect(await getSinkConfigWithSecret(env, a, cfgB.id)).toBeNull();

    expect(await disableSinkConfig(a, cfgB.id, "stolen", 1)).toBe(false);
    expect(await listSinkConfigs(b)).toEqual([cfgB]);
    expect(await getSinkConfigWithSecret(env, b, cfgB.id)).toMatchObject({ disabledAt: null, secret: "token-b" });
  });

  it("keeps sink messages per installation", async () => {
    await putSinkMessage(b, cfgB.id, "trg_1", { externalId: "9", lastHash: "h" }, 1);
    expect(await getSinkMessage(a, cfgB.id, "trg_1")).toBeNull();
  });

  it("refuses a secret moved to another installation's or config's row", async () => {
    const copy = (fromInstallation: number, fromId: string, toInstallation: number, toId: string) =>
      env.DB.prepare(
        `UPDATE sink_configs SET (secret_enc, key_version) = (SELECT secret_enc, key_version FROM sink_configs WHERE installation_id = ?1 AND id = ?2)
        WHERE installation_id = ?3 AND id = ?4`,
      )
        .bind(fromInstallation, fromId, toInstallation, toId)
        .run();
    const otherA = await createSinkConfig(env, a, { kind: "webhook", repo: "org/api", target: "https://hooks.example/a", secret: "hook-a", createdBy: "slack:TA:UA" });

    await copy(1, cfgA.id, 1, otherA.id);
    await expect(getSinkConfigWithSecret(env, a, otherA.id)).rejects.toMatchObject({ code: "token_decrypt_failed" });

    await copy(2, cfgB.id, 1, cfgA.id);
    await expect(getSinkConfigWithSecret(env, a, cfgA.id)).rejects.toMatchObject({ code: "token_decrypt_failed" });
  });
});
