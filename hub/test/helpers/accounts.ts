import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach } from "vitest";
import type { EmailSender, OutgoingEmail } from "../../src/accounts/email";
import { clearTables } from "../db/helpers";
import { createFakeService, type FakeService } from "../fakes/http";

/** Where test requests go; the host is arbitrary to the worker. */
export const ORIGIN = "https://hub.test";
/** What the hub believes its own origin is: the Origin it accepts, and the base of every link it mails or redirects to. */
export const HUB = env.HUB_ORIGIN;
export const GOOD_PASSWORD = "correct horse 7";

/** A mailer that records what would have been sent; nothing leaves the process. */
export class FakeMailer implements EmailSender {
  sent: OutgoingEmail[] = [];
  failWith: Error | null = null;

  async send(mail: OutgoingEmail): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(mail);
  }

  /** The mails sent to one address, oldest first. */
  to(address: string): OutgoingEmail[] {
    return this.sent.filter((mail) => mail.to === address);
  }
}

/** The token in the link of a mail; both the text and the html part carry it. */
export function tokenIn(mail: OutgoingEmail, path: "verify" | "reset-password"): string {
  const match = new RegExp(`${HUB}/account/${path}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text);
  if (!match?.[1]) throw new Error(`no ${path} link in mail text: ${mail.text}`);
  expectHtmlCarriesToken(mail, match[1]);
  return match[1];
}

function expectHtmlCarriesToken(mail: OutgoingEmail, token: string): void {
  if (!mail.html.includes(token)) throw new Error("mail html lacks the link the text part has");
}

/** What a Google token endpoint and userinfo endpoint answer. */
export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean | string;
}

export interface FakeGoogle {
  service: FakeService;
  /** The form fields of every token request, in order. */
  tokenRequests: Record<string, string>[];
  answer(profile: GoogleProfile): void;
}

/** A fake Google token and userinfo endpoint behind env.__TEST_FETCHER. */
export function createFakeGoogle(): FakeGoogle {
  const service = createFakeService(() => Response.json({ error: "not_found" }, { status: 404 }));
  const tokenRequests: Record<string, string>[] = [];
  return {
    service,
    tokenRequests,
    answer(profile) {
      service.respond("POST", "/token", ({ body }) => {
        tokenRequests.push(body as Record<string, string>);
        return Response.json({ access_token: "google-access-token", token_type: "Bearer" });
      });
      service.respond("GET", "/v1/userinfo", ({ headers }) =>
        headers.get("authorization") === "Bearer google-access-token"
          ? Response.json(profile)
          : Response.json({ error: "invalid_token" }, { status: 401 }),
      );
    },
  };
}

/** A browser with its own cookie jar, talking to the worker as one person at one IP. */
export class Browser {
  private readonly jar = new Map<string, string>();

  constructor(readonly ip = "203.0.113.10") {}

  get cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** Puts a cookie the test issued directly (a Set-Cookie value) in the jar, as if the hub had set it. */
  adopt(setCookie: string): void {
    const pair = setCookie.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }

  async fetch(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { "cf-connecting-ip": this.ip, ...init.headers };
    if (this.jar.size > 0) headers.cookie = this.cookieHeader;
    const res = await exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";").map((part) => part.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = attrs.some((attr) => attr.toLowerCase() === "max-age=0");
      if (expired || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  /** The csrf field value of the form on a page this browser has just loaded. */
  async csrfFrom(path: string): Promise<string> {
    const res = await this.fetch(path);
    return csrfIn(await res.text());
  }

  /** Loads the form at formPath for its csrf token, then posts fields to postPath the way a browser would. */
  async submit(formPath: string, postPath: string, fields: Record<string, string>, extra: Record<string, string> = {}): Promise<Response> {
    const csrf = await this.csrfFrom(formPath);
    return this.post(postPath, { ...fields, csrf }, extra);
  }

  /** Follows an emailed verification link the way a person does: opens it, then presses the confirm button. */
  confirmVerify(token: string): Promise<Response> {
    return this.submit(`/account/verify?token=${token}`, "/account/verify", { token });
  }

  post(path: string, fields: Record<string, string>, extra: Record<string, string> = {}): Promise<Response> {
    return this.fetch(path, {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: HUB, ...extra },
    });
  }
}

export function csrfIn(html: string): string {
  const input = /<input[^>]*name="csrf"[^>]*>/.exec(html)?.[0];
  const value = input ? /value="([^"]*)"/.exec(input)?.[1] : undefined;
  if (!value) throw new Error("no csrf field in the page");
  return value;
}

/** Fields of a page's visible text, for comparing the shape of two pages without the per-request csrf value. */
export function pageShape(html: string): string {
  return html.replace(/(name="csrf"[^>]*value=")[^"]*"/g, '$1"').replace(/(value=")[^"]*("[^>]*name="csrf")/g, '$1"$2');
}

interface AccountSetup {
  mailer: FakeMailer;
}

/**
 * Registers the hooks every account test file needs: empty tables, accounts
 * on, a fake mailer, and Google configured when asked. The environment is put
 * back after each test.
 */
export function accountEnvironment(options: { google?: boolean } = {}): AccountSetup {
  const setup: AccountSetup = { mailer: new FakeMailer() };
  const saved = {
    ACCOUNTS_ENABLED: env.ACCOUNTS_ENABLED,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    __TEST_EMAIL: env.__TEST_EMAIL,
    __TEST_FETCHER: env.__TEST_FETCHER,
  };
  beforeEach(async () => {
    await clearTables();
    env.ACCOUNTS_ENABLED = "true";
    setup.mailer.sent = [];
    setup.mailer.failWith = null;
    env.__TEST_EMAIL = setup.mailer;
    if (options.google) {
      env.GOOGLE_CLIENT_ID = "google-client-id";
      env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    } else {
      delete env.GOOGLE_CLIENT_ID;
      delete env.GOOGLE_CLIENT_SECRET;
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(env, key);
      else Reflect.set(env, key, value);
    }
  });
  return setup;
}

/** Signs up and follows the emailed link, leaving a verified account; returns the account id. */
export async function registerVerified(mailer: FakeMailer, email: string, password = GOOD_PASSWORD, ip = "198.51.100.77"): Promise<string> {
  const browser = new Browser(ip);
  const before = mailer.sent.length;
  const res = await browser.submit("/account/register", "/account/register", { email, password });
  if (res.status !== 200) throw new Error(`register answered ${res.status}`);
  const mail = mailer.sent[before];
  if (!mail) throw new Error("no verification mail was sent");
  const verified = await browser.confirmVerify(tokenIn(mail, "verify"));
  if (verified.status !== 200) throw new Error(`verify answered ${verified.status}`);
  const row = await env.DB.prepare("SELECT id FROM users WHERE email_norm = ?1").bind(email.toLowerCase()).first<{ id: string }>();
  if (!row) throw new Error("no account row");
  return row.id;
}
