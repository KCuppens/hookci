import type { D1Migration } from "cloudflare:test";
import type { Env as HubEnv } from "../src/env";
import type * as HubMain from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends HubEnv {
      /** D1 migrations read by vitest.config.ts and applied in test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof HubMain;
    }
  }
}
