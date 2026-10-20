import { createFakeService, type FakeService } from "./http";

/** The fake's Bot API origin; tests set env.TELEGRAM_API_BASE to it. */
export const FAKE_TELEGRAM_API = "https://telegram.test";

/** Fake Telegram Bot API; route a method with botMethod(name). Unmatched requests get Telegram's 404. */
export function createFakeTelegram(): FakeService {
  return createFakeService(() => Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 }));
}

/** The path pattern of a Bot API method under any token. */
export function botMethod(method: string): RegExp {
  return new RegExp(`^/bot[^/]+/${method}$`);
}

/** A Bot API error reply as Telegram sends it. */
export function botError(status: number, description: string, parameters?: Record<string, unknown>): Response {
  return Response.json({ ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) }, { status });
}
