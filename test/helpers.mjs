/**
 * Test helpers: a fetch stub and a couple of envelope builders.
 *
 * Every unit test drives the transport through `stubFetch` rather than the
 * network, so the suite is deterministic and free. The live suite in
 * `integration/live.test.mjs` is the one that talks to the real APIs, and it
 * is skipped unless `DSH_TINYFISH_LIVE=1`.
 */

/**
 * Reduce `fetch`'s `RequestInfo` to the string a route is matched against.
 *
 * `String(url)` is wrong for two of the three cases: a `Request` stringifies to
 * "[object Request]" and a plain object to "[object Object]". Either would turn
 * a route mismatch into something that looks like a transport bug.
 */
function requestInfoToUrl(url) {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

/**
 * Replace `globalThis.fetch` with a queue-driven stub for the duration of `fn`.
 *
 * @param {Array<{ match?: RegExp | string, respond: (req: {url: string, init: object}) => {status?: number, body?: unknown, text?: string} }>} routes
 *   Consumed in order. The last route repeats once exhausted, so a test that
 *   does not care about call count can supply exactly one.
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ result: unknown, calls: object[] }>}
 */
export async function withStubbedFetch(routes, fn) {
  const original = globalThis.fetch;
  const calls = [];
  let index = 0;

  globalThis.fetch = async (url, init = {}) => {
    // `RequestInfo` is `string | URL | Request`. Stringifying a `Request` gives
    // "[object Request]" and a bare object gives "[object Object]", either of
    // which would make a route mismatch look like a transport bug.
    const target = requestInfoToUrl(url);
    const call = { url: target, init, headers: init.headers ?? {} };
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
      json: async () => {
        if (out.invalidJson) throw new SyntaxError("Unexpected token");
        return typeof out.body === "string" ? JSON.parse(out.body) : (out.body ?? {});
      },
      text: async () => body,
    };
  };

  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** A completed Monid run envelope carrying TinyFish's search payload. */
export function searchEnvelope(results, extra = {}) {
  return {
    runId: "run_1",
    status: "COMPLETED",
    output: { query: "q", results, total_results: results.length, page: 0 },
    ...extra,
  };
}

/** A completed Monid run envelope carrying TinyFish's fetch payload. */
export function fetchEnvelope(results = [], errors = []) {
  return {
    runId: "run_1",
    status: "COMPLETED",
    output: { results, errors },
  };
}

/** One TinyFish search hit, with only the fields a test cares about. */
export function hit(overrides = {}) {
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
export function abortedSignal(reason = "caller cancelled") {
  return AbortSignal.abort(reason);
}
