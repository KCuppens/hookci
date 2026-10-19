import type { Fetcher } from "../../src/http";

export type FakeCall = { method: string; url: string; body: unknown };

export type FakeRequest = FakeCall & {
  /** Values of `:name` segments or named RegExp groups in the matched pattern. */
  params: Record<string, string>;
  headers: Headers;
};

export type FakeHandler = (req: FakeRequest) => Response | Promise<Response>;

export interface FakeService {
  fetcher: Fetcher;
  /** Every request the fetcher received, in order. */
  calls: FakeCall[];
  /**
   * Answers requests whose method and URL path match. pathPattern is either a
   * path with `:name` segments (`/repos/:owner/:repo`) matched exactly, or a
   * RegExp tested against the path. A later registration wins over an earlier one.
   */
  respond(method: string, pathPattern: string | RegExp, handler: FakeHandler): void;
}

type Route = { method: string; pattern: RegExp; handler: FakeHandler };

const live = new Set<{ calls: FakeCall[]; routes: Route[] }>();

/**
 * Clears recorded calls and registered handlers of every fake. test/setup.ts
 * runs it before each test, so register handlers in the test or a beforeEach.
 */
export function resetFakes(): void {
  for (const fake of live) {
    fake.calls.length = 0;
    fake.routes.length = 0;
  }
}

function compile(pathPattern: string | RegExp): RegExp {
  if (pathPattern instanceof RegExp) return pathPattern;
  const source = pathPattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? `(?<${seg.slice(1)}>[^/]+)` : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text === "") return undefined;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A fake HTTP service; unmatched requests get notFound(). */
export function createFakeService(notFound: () => Response): FakeService {
  const calls: FakeCall[] = [];
  const routes: Route[] = [];
  live.add({ calls, routes });

  const fetcher: Fetcher = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const call: FakeCall = { method: req.method, url: req.url, body: await readBody(req) };
    calls.push(call);
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i]!;
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (match) return route.handler({ ...call, params: { ...match.groups }, headers: req.headers });
    }
    return notFound();
  };

  return {
    fetcher,
    calls,
    respond(method, pathPattern, handler) {
      routes.push({ method: method.toUpperCase(), pattern: compile(pathPattern), handler });
    },
  };
}
