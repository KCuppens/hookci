import { describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../../src/db/tenant";
import { columnsOf, schemaTables } from "./helpers";

describe("TENANT_TABLES", () => {
  it("lists exactly the migrated tables with an installation_id column", async () => {
    const withInstallationId: string[] = [];
    for (const table of await schemaTables()) {
      if ((await columnsOf(table)).includes("installation_id")) withInstallationId.push(table);
    }
    expect([...TENANT_TABLES].sort()).toEqual(withInstallationId.sort());
  });
});
