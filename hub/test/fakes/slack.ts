import { createFakeService, type FakeService } from "./http";

/** Fake Slack Web API and response_url endpoints; unmatched requests get 404. */
export function createFakeSlack(): FakeService {
  return createFakeService(() => Response.json({ ok: false, error: "unknown_method" }, { status: 404 }));
}
