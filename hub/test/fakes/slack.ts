import { createFakeService, type FakeService } from "./http";

/** Methods ZeroCI must never call: it keeps what it posted instead of reading channels back. */
export const FORBIDDEN_SLACK_METHODS = ["conversations.history", "conversations.replies"];

/**
 * Fake Slack Web API and response_url endpoints; unmatched requests get 404,
 * and FORBIDDEN_SLACK_METHODS answer missing_scope however a test routes them.
 */
export function createFakeSlack(): FakeService {
  const fake = createFakeService(() => Response.json({ ok: false, error: "unknown_method" }, { status: 404 }));
  const respond = fake.respond;
  const forbidden = new RegExp(`^/api/(?:${FORBIDDEN_SLACK_METHODS.map((m) => m.replace(".", "\\.")).join("|")})$`);
  return {
    ...fake,
    respond(method, pathPattern, handler) {
      respond(method, pathPattern, (req) =>
        forbidden.test(new URL(req.url).pathname) ? Response.json({ ok: false, error: "missing_scope" }) : handler(req),
      );
    },
  };
}
