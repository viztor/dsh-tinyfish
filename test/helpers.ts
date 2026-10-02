/**
 * Test helpers: a fetch stub and a couple of envelope builders.
 *
 * Every unit test drives the transport through `withStubbedFetch` rather than
 * the network, so the suite is deterministic and free. The live suite in
 * `integration/live.test.ts` is the one that talks to the real APIs, and it
 * is skipped unless `DSH_TINYFISH_LIVE=1`.
 */

import assert from "node:assert/strict";

/**
 * The `index`-th element of a list the test has just reasoned about.
 *
 * `noUncheckedIndexedAccess` types every array read `T | undefined`, and each
 * call below already rests on an assumption about how many entries a list
 * holds. Going through this lookup turns that assumption into a failure at the
 * point of the assumption — naming the list, the index and the count — instead
 * of a later `Cannot read properties of undefined` that names none of them.
 *
 * It lives here rather than in each file because the three suites read arrays
 * for the same reason: a stub recorded N requests and the assertions that
 * follow are about entry number i.
 */
export function nth<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  assert.ok(item, `expected ${what} #${index} of ${items.length}`);
  return item;
}

/** What a stubbed call records, and what a route can answer with. */
export interface StubCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  invalidJson?: boolean;
}

export interface StubRoute {
  match?: RegExp | string;
  respond: (call: StubCall) => StubResponse;
}

/**
 * Reduce `fetch`'s `RequestInfo` to the string a route is matched against.
 *
 * `String(url)` is wrong for two of the three cases: a `Request` stringifies to
 * "[object Request]" and a plain object to "[object Object]". Either would turn
 * a route mismatch into something that looks like a transport bug.
 */
function requestInfoToUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

/**
 * Replace `globalThis.fetch` with a queue-driven stub for the duration of `fn`.
 *
 * Routes are consumed in order. The last route repeats once exhausted, so a
 * test that does not care about call count can supply exactly one.
 */
export async function withStubbedFetch<T>(
  routes: StubRoute[],
  fn: () => Promise<T>
): Promise<{ result: T; calls: StubCall[] }> {
  const original = globalThis.fetch;
  const calls: StubCall[] = [];
  let index = 0;

  globalThis.fetch = (async (
    url: string | URL | Request,
    init: RequestInit = {}
  ) => {
    const target = requestInfoToUrl(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: StubCall = { url: target, init, headers };
    calls.push(call);
    const route = routes[Math.min(index, routes.length - 1)];
    index += 1;
    if (!route) throw new Error(`no stub route for ${target}`);
    const out = route.respond(call);
    const status = out.status ?? 200;
    const body = out.text ?? JSON.stringify(out.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async (): Promise<unknown> => {
        if (out.invalidJson) throw new SyntaxError("Unexpected token");
        return typeof out.body === "string"
          ? (JSON.parse(out.body) as unknown)
          : (out.body ?? {});
      },
      text: async (): Promise<string> => body,
    } satisfies Pick<Response, "ok" | "status" | "json" | "text">;
  }) as typeof fetch;

  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** A search hit, with only the fields a test cares about. */
export interface StubHit {
  position: number;
  site_name: string;
  title: string;
  snippet: string;
  url: string;
  date: string;
  [key: string]: unknown;
}

/** A completed Monid run envelope carrying TinyFish's search payload. */
export function searchEnvelope(
  results: StubHit[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    runId: "run_1",
    status: "COMPLETED",
    output: { query: "q", results, total_results: results.length, page: 0 },
    ...extra,
  };
}

/** A completed Monid run envelope carrying TinyFish's fetch payload. */
export function fetchEnvelope(
  results: unknown[] = [],
  errors: unknown[] = []
): Record<string, unknown> {
  return {
    runId: "run_1",
    status: "COMPLETED",
    output: { results, errors },
  };
}

/** One TinyFish search hit, with only the fields a test cares about. */
export function hit(overrides: Partial<StubHit> = {}): StubHit {
  return {
    position: 1,
    site_name: "example.com",
    title: "A title",
    snippet: "A snippet",
    url: "https://example.com/page",
    date: "Apr 30, 2026",
    ...overrides,
  };
}

/** An abort signal that has already fired. */
export function abortedSignal(reason = "caller cancelled"): AbortSignal {
  return AbortSignal.abort(reason);
}
