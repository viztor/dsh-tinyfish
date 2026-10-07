/**
 * Provider tests: how TinyFish payloads become the seam's vocabulary.
 *
 * The seam owns truncation, cancellation and error codes, so what is tested
 * here is the mapping and the edges a mapping can get wrong — a missing URL, a
 * human date string, a 404 arriving in `errors[]` rather than `results[]`.
 *
 * No network: each provider is handed a `resolveOptions` thunk and driven
 * through a stubbed transport.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Assertions stay on `node:assert` so that a failure here can only be the runner
// swap, never an assertion-library rewrite.
import { test } from "vitest";

import {
  TinyfishFetchProvider,
  TinyfishSearchProvider,
  toIsoDate,
  type TinyfishProviderOptions,
} from "../src/provider.ts";
import {
  fetchEnvelope,
  hit,
  nth,
  searchEnvelope,
  withStubbedFetch,
  type StubHit,
} from "./helpers.ts";

// Typed as the provider's options: `channel` must be a channel, not any
// string, or the thunk is not a valid options source. `delayMs` rides along
// as fixture-only ballast the provider never reads.
const OPTIONS: TinyfishProviderOptions & { delayMs: number } = {
  channel: "monid",
  apiKey: "k",
  apiKeyEnv: "TINYFISH_API_KEY",
  monidKeyEnv: "MONID_API_KEY",
  filters: {},
  fetchOptions: {},
  attempts: 1,
  delayMs: 1,
  monidBase: "https://api.monid.ai",
  searchBase: "https://api.search.tinyfish.ai",
  fetchBase: "https://api.fetch.tinyfish.ai",
  search: true,
  fetch: true,
};

const search = () => new TinyfishSearchProvider(() => OPTIONS);
const fetchp = () => new TinyfishFetchProvider(() => OPTIONS);

/* ------------------------------------------------------------ date coercion */

test("toIsoDate: an unzoned human date reads as UTC, not local midnight", () => {
  // `Date.parse("Apr 30, 2026")` means local midnight, so a naive conversion
  // would report a different day for any host east or west of Greenwich.
  assert.equal(toIsoDate("Apr 30, 2026"), "2026-04-30T00:00:00.000Z");
  assert.equal(toIsoDate("2026-04-30"), "2026-04-30T00:00:00.000Z");
  assert.equal(toIsoDate("  Apr 30, 2026  "), "2026-04-30T00:00:00.000Z");
});

test("toIsoDate: an explicit offset or clock time is respected", () => {
  assert.equal(toIsoDate("2026-04-30T12:00:00Z"), "2026-04-30T12:00:00.000Z");
  assert.equal(
    toIsoDate("2026-04-30T12:00:00+02:00"),
    "2026-04-30T10:00:00.000Z"
  );
});

test("toIsoDate: relative and unparseable values are dropped, not guessed", () => {
  assert.equal(toIsoDate("1 year ago"), undefined);
  assert.equal(toIsoDate("yesterday"), undefined);
  assert.equal(toIsoDate(""), undefined);
  assert.equal(toIsoDate("   "), undefined);
  assert.equal(toIsoDate(undefined), undefined);
  assert.equal(
    toIsoDate(12_345 as unknown as string),
    undefined,
    "a non-string is not a date"
  );
});

/* ------------------------------------------------------------------ search */

test("search maps results into citeable sources", async () => {
  const { result } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([hit()]) }) }],
    async () => search().search({ query: "q" })
  );
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0], {
    url: "https://example.com/page",
    title: "A title",
    snippet: "A snippet",
    publishedAt: "2026-04-30T00:00:00.000Z",
  });
  assert.equal(
    result.truncated,
    false,
    "the seam owns truncation, not the provider"
  );
  assert.equal(
    result.content,
    undefined,
    "tinyfish ranks, it does not generate an answer"
  );
});

test("search omits fields the payload did not supply", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: searchEnvelope([
            // Deliberately partial: the point is that absent fields are omitted.
            { url: "https://x", title: "T", date: "1 year ago" } as StubHit,
          ]),
        }),
      },
    ],
    async () => search().search({ query: "q" })
  );
  assert.deepEqual(result.sources[0], { url: "https://x", title: "T" });
});

test("search drops hits with no url rather than emitting an uncitable source", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: searchEnvelope([
            hit(),
            // A hit with no url: dropped, never emitted as a source.
            { title: "orphan" } as StubHit,
            hit({ url: "https://b" }),
          ]),
        }),
      },
    ],
    async () => search().search({ query: "q" })
  );
  assert.deepEqual(
    result.sources.map((s) => s.url),
    ["https://example.com/page", "https://b"]
  );
});

test("search accepts `description` as an alias for `snippet`", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: searchEnvelope([
            // `description` is accepted as a `snippet` alias. Cast through
            // `unknown`: `description` is not a `StubHit` field, so a direct
            // assertion does not overlap enough to satisfy the checker.
            {
              url: "https://x",
              title: "T",
              description: "D",
            } as unknown as StubHit,
          ]),
        }),
      },
    ],
    async () => search().search({ query: "q" })
  );
  assert.ok(result.sources[0], "one hit came back");
  assert.equal(result.sources[0].snippet, "D");
});

test("search returns no sources when the upstream genuinely has none", async () => {
  const { result } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([]) }) }],
    async () => search().search({ query: "q" })
  );
  assert.deepEqual(result.sources, []);
  assert.equal(result.truncated, false);
});

test("search forwards purpose and filters from config to the request", async () => {
  // The wiring test for the seam's standing defaults: everything the config
  // row chose arrives on the request, including the members that were added
  // long after the provider was written. A field declared in the schema but
  // never threaded this far would pass every config-level test in the suite.
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([]) }) }],
    async () =>
      new TinyfishSearchProvider(() => ({
        ...OPTIONS,
        purpose: "size the market",
        filters: { domain_type: "news", recency_minutes: 60 },
      })).search({ query: "q" })
  );
  const body = JSON.parse(nth(calls, 0, "request").init.body as string);
  assert.deepEqual(body.input.queryParams, {
    query: "q",
    domain_type: "news",
    recency_minutes: 60,
    purpose: "size the market",
  });
});

test("fetch forwards purpose and the fetchOptions group to the body", async () => {
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: fetchEnvelope([{ url: "https://x" }]) }) }],
    async () =>
      new TinyfishFetchProvider(() => ({
        ...OPTIONS,
        purpose: "size the market",
        fetchOptions: {
          ttl: 0,
          per_url_timeout_ms: 30_000,
          exclude_selectors: ["nav"],
        },
      })).fetch({ url: "https://x" })
  );
  const body = JSON.parse(nth(calls, 0, "request").init.body as string);
  assert.deepEqual(
    body.input.body,
    {
      urls: ["https://x"],
      format: "markdown",
      purpose: "size the market",
      ttl: 0,
      per_url_timeout_ms: 30_000,
      exclude_selectors: ["nav"],
    },
    "the group rides as one field, in the upstream's own names"
  );
});

test("available() is a local check and never touches the network", async () => {
  const { calls, result } = await withStubbedFetch([], async () => {
    const provider = new TinyfishSearchProvider(() => ({
      ...OPTIONS,
      apiKey: "k",
    }));
    const a = provider.available();
    const b = provider.available();
    return { a, b };
  });
  assert.equal(result.a, true);
  assert.equal(result.b, true);
  assert.equal(calls.length, 0, "available() must not make network calls");
});

/**
 * Run `body` where no credential can leak in from this machine: every
 * conventional variable unset and `$HOME` pointing at a directory that holds
 * nothing, so the CLI stores behind `~/.tinyfish` and `~/.config/monid` read
 * as absent.
 *
 * Without it, a test that means "there is no key here" is really asking
 * whether *this* host has one — which is why `available()`'s answer for a
 * keyless configuration could not be pinned at all before.
 */
function withoutAmbientCredential(body: () => void): void {
  // Saved and restored one name at a time rather than through a list: deleting
  // a computed key is a lint gate (`typescript/no-dynamic-delete`), and these
  // four names *are* the rungs this helper exists to switch off, so naming
  // each is clearer than an array that walks around the rule.
  const homeBefore = process.env.HOME;
  const tinyfish = process.env.TINYFISH_API_KEY;
  const monidKey = process.env.MONID_API_KEY;
  const monidToken = process.env.MONID_MCP_TOKEN;
  const custom = process.env.MY_TINY_KEY;
  const home = mkdtempSync(join(tmpdir(), "tf-home-"));
  try {
    delete process.env.TINYFISH_API_KEY;
    delete process.env.MONID_API_KEY;
    delete process.env.MONID_MCP_TOKEN;
    delete process.env.MY_TINY_KEY;
    process.env.HOME = home;
    body();
  } finally {
    // `process.env.X = undefined` would store the *string* "undefined" — a
    // credential-shaped nothing, which is the one outcome this helper must not
    // produce — so an originally absent name is deleted back to absent.
    if (homeBefore === undefined) delete process.env.HOME;
    else process.env.HOME = homeBefore;
    if (tinyfish === undefined) delete process.env.TINYFISH_API_KEY;
    else process.env.TINYFISH_API_KEY = tinyfish;
    if (monidKey === undefined) delete process.env.MONID_API_KEY;
    else process.env.MONID_API_KEY = monidKey;
    if (monidToken === undefined) delete process.env.MONID_MCP_TOKEN;
    else process.env.MONID_MCP_TOKEN = monidToken;
    if (custom === undefined) delete process.env.MY_TINY_KEY;
    else process.env.MY_TINY_KEY = custom;
    rmSync(home, { recursive: true, force: true });
  }
}

test("available() reads the same credential rungs as the request path", () => {
  // `hasCredential` built a synthetic env that mapped *every* conventional
  // name to `process.env[ref]` and never forwarded `apiKeyEnv`, so neither of
  // the two rungs `resolveApiKey` documents was visible to the check: the
  // configured reference was skipped outright, and a conventional name was
  // read under the wrong variable. `dsh-web` asks `available()` before it
  // dispatches, so the disagreement reached the user as
  // WEB_PROVIDER_CONFIGURED_UNAVAILABLE — on a configuration the request
  // path resolves without complaint.
  withoutAmbientCredential(() => {
    // The configured reference of the user's own choosing, absent, with the
    // channel's conventional name exported: the request path reads the ref
    // first, finds nothing, and falls through to `TINYFISH_API_KEY`.
    process.env.TINYFISH_API_KEY = "conventional";
    const configured = new TinyfishSearchProvider(() => ({
      ...OPTIONS,
      channel: "direct",
      apiKey: undefined,
      apiKeyEnv: "MY_TINY_KEY",
    }));
    assert.equal(
      configured.available(),
      true,
      "the channel's conventional name counts"
    );

    // …and the same ref when it *is* exported, which is the rung the
    // synthetic env skipped entirely.
    delete process.env.TINYFISH_API_KEY;
    process.env.MY_TINY_KEY = "named";
    assert.equal(
      configured.available(),
      true,
      "the configured reference counts"
    );
    delete process.env.MY_TINY_KEY;

    // The monid channel's second conventional name — `MONID_MCP_TOKEN`, the
    // fallthrough `resolveApiKey` keeps both rungs for — exported on its own.
    process.env.MONID_MCP_TOKEN = "mcp";
    const monid = new TinyfishSearchProvider(() => ({
      ...OPTIONS,
      apiKey: undefined,
    }));
    assert.equal(monid.available(), true, "MONID_MCP_TOKEN counts");
    delete process.env.MONID_MCP_TOKEN;

    // Nothing at all still reads `false`. The rule under test is "never
    // disagree with the request path", not "always available".
    const keyless = new TinyfishSearchProvider(() => ({
      ...OPTIONS,
      apiKey: undefined,
    }));
    assert.equal(keyless.available(), false, "no credential, no provider");
  });
});

test("available() counts a credential the harness service may hold", () => {
  // The credentials service is the documented home for both keys — README
  // rung 2, and the settings page is where a key gets saved into it — but
  // `resolve` is async while `available()` must answer synchronously. A key
  // saved *only* from Settings therefore read as "no credential" here, and
  // `dsh-web` gates on `available()` before dispatching, so the search failed
  // with WEB_PROVIDER_CONFIGURED_UNAVAILABLE even though `resolveApiKeyAsync`
  // resolves that very key on the request path.
  withoutAmbientCredential(() => {
    let consulted = false;
    const options: TinyfishProviderOptions = {
      ...OPTIONS,
      apiKey: undefined,
      resolveCredential: async () => {
        consulted = true;
        return "service-key";
      },
    };
    assert.equal(
      new TinyfishSearchProvider(() => options).available(),
      true,
      "a wired resolver means a key may exist"
    );
    assert.equal(
      new TinyfishFetchProvider(() => options).available(),
      true,
      "for both kinds"
    );
    assert.equal(
      consulted,
      false,
      "and the check still never starts a lookup it cannot await"
    );
  });
});

test("available() is always a strict boolean, even from a malformed row", () => {
  // `&&` yields the first falsy *operand*, not `false`. A partial options object
  // — an untyped fixture, or a row that reached the provider unvalidated — made
  // `available()` return `undefined` from a method the seam declares as boolean.
  // The seam uses it to choose between providers, so the declared type has to
  // hold at runtime, not just in the type checker.
  // A row missing its flags: deliberately malformed, cast at the boundary so
  // the test still proves `available()` returns a strict boolean for one.
  const partial: Partial<TinyfishProviderOptions> = {
    channel: "monid",
    apiKey: "k",
    filters: {},
    attempts: 1,
  };
  for (const provider of [
    new TinyfishSearchProvider(() => partial as TinyfishProviderOptions),
    new TinyfishFetchProvider(() => partial as TinyfishProviderOptions),
  ]) {
    const value = provider.available();
    assert.equal(
      typeof value,
      "boolean",
      `${provider.constructor.name} returns a boolean`
    );
    assert.equal(value, false, "and a row missing its flags is not available");
  }
  // The well-formed case must still be true, or the coercion would be hiding a
  // regression rather than fixing one.
  assert.equal(typeof search().available(), "boolean");
  assert.equal(search().available(), true);
  assert.equal(fetchp().available(), true);
});

test("a switched-off kind registers but reports itself unavailable", () => {
  // Not registering would be worse: `dsh-web` would raise
  // WEB_PROVIDER_CONFIGURED_MISSING for a profile that still names `tinyfish`,
  // which reads as a broken install. Registering and declining reads as "off".
  const off = { ...OPTIONS, search: false, fetch: false };
  assert.equal(new TinyfishSearchProvider(() => off).available(), false);
  assert.equal(new TinyfishFetchProvider(() => off).available(), false);

  // The switches are independent: one off does not take the other with it.
  const onlyFetch = { ...OPTIONS, search: false };
  assert.equal(new TinyfishSearchProvider(() => onlyFetch).available(), false);
  assert.equal(new TinyfishFetchProvider(() => onlyFetch).available(), true);
  const onlySearch = { ...OPTIONS, fetch: false };
  assert.equal(new TinyfishSearchProvider(() => onlySearch).available(), true);
  assert.equal(new TinyfishFetchProvider(() => onlySearch).available(), false);
});

/* ------------------------------------------------------------------- fetch */

test("fetch returns markdown as kind:text, skipping the tool's turndown", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope([{ url: "https://x", text: "# Heading" }]),
        }),
      },
    ],
    async () => fetchp().fetch({ url: "https://x" })
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.kind, "text");
  assert.equal(result.body.content, "# Heading");
  assert.equal(result.truncated, false);
});

test("fetch reports the final URL after redirects", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope([
            { url: "https://x", final_url: "https://y", text: "t" },
          ]),
        }),
      },
    ],
    async () => fetchp().fetch({ url: "https://x" })
  );
  assert.equal(result.url, "https://y");
});

test("a 404 is a result carrying its status, not a thrown error", async () => {
  // The seam's contract: a non-2xx response is resource state, and the model
  // needs the status to reason about it.
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope(
            [],
            [{ url: "https://x", error: "page_not_found", status: 404 }]
          ),
        }),
      },
    ],
    async () => fetchp().fetch({ url: "https://x" })
  );
  assert.equal(result.statusCode, 404);
  assert.equal(result.url, "https://x");
  assert.match(result.body.content, /page_not_found/);
  assert.match(result.body.content, /404/);
});

test("a fetch error for a different URL does not poison this one", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope(
            [{ url: "https://wanted", text: "ok" }],
            [{ url: "https://other", error: "boom", status: 500 }]
          ),
        }),
      },
    ],
    async () => fetchp().fetch({ url: "https://wanted" })
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.content, "ok");
});

test("a trailing slash does not stop a fetch error from matching its request", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope(
            [],
            [{ url: "https://x/", error: "gone", status: 410 }]
          ),
        }),
      },
    ],
    async () => fetchp().fetch({ url: "https://x" })
  );
  assert.equal(result.statusCode, 410);
});

test("neither a result nor an error is a provider fault, and throws", async () => {
  await assert.rejects(
    withStubbedFetch(
      [{ respond: () => ({ body: fetchEnvelope([], []) }) }],
      async () => fetchp().fetch({ url: "https://x" })
    ).then((r) => r.result),
    (error: unknown) =>
      error instanceof Error && error.message.includes("returned no content")
  );
});

test("an error with no numeric status still returns a result", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope([], [{ url: "https://x", error: "blocked" }]),
        }),
      },
    ],
    async () => fetchp().fetch({ url: "https://x" })
  );
  assert.equal(
    result.statusCode,
    502,
    "an unstatusable failure is a bad gateway"
  );
});

test("empty page text is still a result, not a failure", async () => {
  const { result } = await withStubbedFetch(
    [{ respond: () => ({ body: fetchEnvelope([{ url: "https://x" }]) }) }],
    async () => fetchp().fetch({ url: "https://x" })
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.content, "");
});

/* ------------------------------------------------- the stored credential */

test("a search sends the key the Settings store holds, not the CLI one", async () => {
  // The regression this guards: the provider resolved options but never passed
  // the credential-ref or the resolver down to the client, so a key saved from
  // the settings UI was never consulted and the request fell through to the
  // environment and the CLI store. The UI would look like it saved a key while
  // searches kept using a different one.
  const options = {
    ...OPTIONS,
    apiKey: undefined,
    resolveCredential: async (name: string) =>
      name === "MONID_API_KEY" ? "stored-monid" : undefined,
  };
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([]) }) }],
    async () => new TinyfishSearchProvider(() => options).search({ query: "q" })
  );
  assert.equal(
    nth(calls, 0, "request").headers.Authorization,
    "Bearer stored-monid",
    "the monid channel reads the monid ref"
  );
});

test("the direct channel reads its own ref, never the monid one", async () => {
  const store: Record<string, string> = {
    TINYFISH_API_KEY: "stored-tinyfish",
    MONID_API_KEY: "stored-monid",
  };
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: { results: [], total_results: 0 } }) }],
    async () =>
      new TinyfishSearchProvider(() => ({
        ...OPTIONS,
        channel: "direct",
        apiKey: undefined,
        resolveCredential: async (name: string) => store[name],
      })).search({ query: "q" })
  );
  assert.equal(
    nth(calls, 0, "request").headers["X-API-Key"],
    "stored-tinyfish"
  );
});

test("a fetch also uses the stored credential", async () => {
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: fetchEnvelope([{ url: "https://x" }]) }) }],
    async () =>
      new TinyfishFetchProvider(() => ({
        ...OPTIONS,
        apiKey: undefined,
        resolveCredential: async (name: string) =>
          name === "MONID_API_KEY" ? "stored-monid" : undefined,
      })).fetch({ url: "https://x" })
  );
  assert.equal(
    nth(calls, 0, "request").headers.Authorization,
    "Bearer stored-monid"
  );
});
