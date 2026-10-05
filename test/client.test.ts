/**
 * Transport-level tests: credential resolution, request shape, retry policy,
 * and the error mapping for each way a run can fail.
 *
 * No network. `fetch` is stubbed per test.
 */

import assert from "node:assert/strict";
// Assertions stay on `node:assert` so that a failure here can only be the runner
// swap, never an assertion-library rewrite.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import {
  DEFAULT_FETCH_BASE,
  DEFAULT_MONID_BASE,
  DEFAULT_SEARCH_BASE,
  WEB_PROVIDER_CREDENTIAL_MISSING,
  WebError,
  abortable,
  resolveApiKey,
  resolveApiKeyAsync,
  tinyfishFetch,
  tinyfishSearch,
} from "../src/client.ts";
import {
  fetchEnvelope,
  hit,
  nth,
  searchEnvelope,
  withStubbedFetch,
} from "./helpers.ts";

const NO_ENV = {};

/* ----------------------------------------------------------- credentials */

test("resolveApiKey: explicit config outranks everything", () => {
  const key = resolveApiKey("direct", {
    apiKey: "explicit",
    env: { TINYFISH_API_KEY: "from-env" },
  });
  assert.equal(key, "explicit");
});

test("resolveApiKey: a blank explicit key does not shadow the environment", () => {
  const key = resolveApiKey("direct", {
    apiKey: "   ",
    env: { TINYFISH_API_KEY: "from-env" },
  });
  assert.equal(key, "from-env", "whitespace is not a credential");
});

test("resolveApiKey: MONID_API_KEY wins over MONID_MCP_TOKEN", () => {
  assert.equal(
    resolveApiKey("monid", {
      env: { MONID_API_KEY: "a", MONID_MCP_TOKEN: "b" },
    }),
    "a"
  );
});

test("resolveApiKey: MONID_MCP_TOKEN is accepted, so the DSH host mount works", () => {
  // The patch row exports exactly this variable; the plugin must honour it.
  assert.equal(resolveApiKey("monid", { env: { MONID_MCP_TOKEN: "t" } }), "t");
});

test("resolveApiKey: the two channels never read each other's variable", () => {
  // Both store paths are stubbed so a credential on this machine cannot mask
  // the assertion: what is being tested is the variable routing, not the store.
  assert.equal(
    resolveApiKey("direct", {
      env: { MONID_API_KEY: "m" },
      tinyfishConfigPath: "/nope/absent",
    }),
    ""
  );
  assert.equal(
    resolveApiKey("monid", {
      env: { TINYFISH_API_KEY: "t" },
      credentialsPath: "/nope/absent",
    }),
    ""
  );
});

test("resolveApiKey: reads the monid CLI credential file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-monid-"));
  try {
    const file = join(dir, "credentials.yaml");
    writeFileSync(
      file,
      [
        "keys:",
        "  main:",
        "    key: monid_live_primary",
        "    prefix: monid_live",
        "  spare:",
        "    key: monid_live_spare",
        "",
      ].join("\n")
    );
    assert.equal(
      resolveApiKey("monid", { env: NO_ENV, credentialsPath: file }),
      "monid_live_primary"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiKey: prefers the entry named by active_key", () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-monid-"));
  try {
    const file = join(dir, "credentials.yaml");
    writeFileSync(
      file,
      [
        "active_key: spare",
        "keys:",
        "  main:",
        "    key: monid_live_primary",
        "  spare:",
        "    key: monid_live_spare",
        "",
      ].join("\n")
    );
    assert.equal(
      resolveApiKey("monid", { env: NO_ENV, credentialsPath: file }),
      "monid_live_spare"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiKey: reads the tinyfish CLI config", () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-direct-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ api_key: "sk-tinyfish-abc" }));
    assert.equal(
      resolveApiKey("direct", { env: NO_ENV, tinyfishConfigPath: file }),
      "sk-tinyfish-abc"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiKey: tolerates Windows line endings in the CLI file", () => {
  // An editor or a sync tool can leave `\r\n` behind. The key regex anchors on
  // `$` with the multiline flag, and `\r` would become part of the captured
  // key without the trailing `\s*` — sending a key with a carriage return
  // that the upstream rejects as malformed rather than missing.
  const dir = mkdtempSync(join(tmpdir(), "tf-monid-"));
  try {
    const file = join(dir, "credentials.yaml");
    writeFileSync(
      file,
      ["keys:", "  main:", "    key: monid_live_win", ""].join("\r\n")
    );
    assert.equal(
      resolveApiKey("monid", { env: NO_ENV, credentialsPath: file }),
      "monid_live_win"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiKey: an active_key naming nothing falls back to the first key", () => {
  // A rotated-out entry can leave `active_key` pointing at a name that no
  // longer exists. Treating that as "no credential" would break a host that
  // has a perfectly good key under another name; falling back keeps it working
  // while the operator cleans up the file.
  const dir = mkdtempSync(join(tmpdir(), "tf-monid-"));
  try {
    const file = join(dir, "credentials.yaml");
    writeFileSync(
      file,
      [
        "active_key: gone",
        "keys:",
        "  main:",
        "    key: monid_live_only",
        "",
      ].join("\n")
    );
    assert.equal(
      resolveApiKey("monid", { env: NO_ENV, credentialsPath: file }),
      "monid_live_only"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiKey: a missing or malformed store yields empty, not a throw", () => {
  assert.equal(
    resolveApiKey("monid", { env: NO_ENV, credentialsPath: "/nope/absent" }),
    ""
  );
  const dir = mkdtempSync(join(tmpdir(), "tf-bad-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, "{not json");
    assert.equal(
      resolveApiKey("direct", { env: NO_ENV, tinyfishConfigPath: file }),
      ""
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ref that names an environment variable is read from that variable", () => {
  assert.equal(
    resolveApiKey("direct", {
      apiKeyEnv: "MY_TINYFISH",
      env: { MY_TINYFISH: "from-named-var" },
      tinyfishConfigPath: "/nope/absent",
    }),
    "from-named-var"
  );
});

test("a named ref does not hide the channel's own conventional names", () => {
  assert.equal(
    resolveApiKey("monid", {
      monidKeyEnv: "MONID_API_KEY",
      env: { MONID_MCP_TOKEN: "mcp" },
      credentialsPath: "/nope/absent",
    }),
    "mcp"
  );
});

/* ------------------------------------------------- the credentials service */

test("a stored credential is preferred over the ambient environment", async () => {
  // The harness store is more specific than whatever happens to be exported,
  // and it is where a user rotates a key from Settings.
  const key = await resolveApiKeyAsync("direct", {
    apiKeyEnv: "TINYFISH_API_KEY",
    resolveCredential: async (name) =>
      name === "TINYFISH_API_KEY" ? "from-store" : undefined,
    env: { TINYFISH_API_KEY: "from-env" },
    tinyfishConfigPath: "/nope/absent",
  });
  assert.equal(key, "from-store");
});

test("a missing stored credential falls through to the environment", async () => {
  const key = await resolveApiKeyAsync("direct", {
    apiKeyEnv: "TINYFISH_API_KEY",
    resolveCredential: async () => {},
    env: { TINYFISH_API_KEY: "from-env" },
  });
  assert.equal(key, "from-env");
});

test("a failing credential service does not fail the search", async () => {
  // The CLI stores are a working fallback; treating a service hiccup as fatal
  // would take out a provider that was fine a moment ago.
  const key = await resolveApiKeyAsync("direct", {
    apiKeyEnv: "TINYFISH_API_KEY",
    resolveCredential: async () => {
      throw new Error("credentials service is down");
    },
    env: { TINYFISH_API_KEY: "from-env" },
  });
  assert.equal(key, "from-env");
});

test("a literal key still outranks the credentials service", async () => {
  const key = await resolveApiKeyAsync("direct", {
    apiKey: "literal",
    apiKeyEnv: "TINYFISH_API_KEY",
    resolveCredential: async () => "from-store",
  });
  assert.equal(key, "literal");
});

test("each channel reads its own credential ref, never the other's", async () => {
  // A user who stores both keys must not have the TinyFish key sent to Monid
  // as its bearer token. That fails upstream as a 401, which reads as "your
  // Monid key is wrong" rather than as "the wrong slot was consulted".
  const store: Record<string, string> = {
    TINYFISH_API_KEY: "tinyfish-key",
    MONID_API_KEY: "monid-key",
  };
  const resolveCredential = async (name: string): Promise<string | undefined> =>
    store[name];

  assert.equal(
    await resolveApiKeyAsync("direct", {
      apiKeyEnv: "TINYFISH_API_KEY",
      monidKeyEnv: "MONID_API_KEY",
      resolveCredential,
      tinyfishConfigPath: "/nope/absent",
    }),
    "tinyfish-key"
  );
  assert.equal(
    await resolveApiKeyAsync("monid", {
      apiKeyEnv: "TINYFISH_API_KEY",
      monidKeyEnv: "MONID_API_KEY",
      resolveCredential,
      credentialsPath: "/nope/absent",
    }),
    "monid-key"
  );
});

test("a channel with no ref of its own falls through to its own rungs", async () => {
  // The monid channel's fallbacks (MONID_API_KEY, MONID_MCP_TOKEN, the CLI
  // store) are already the right answers, so an unconfigured ref must simply
  // be skipped rather than defaulted to the other channel's name.
  const key = await resolveApiKeyAsync("monid", {
    apiKeyEnv: "TINYFISH_API_KEY",
    monidKeyEnv: undefined,
    resolveCredential: async () => "should-not-be-read",
    env: { MONID_API_KEY: "monid-from-env" },
  });
  assert.equal(key, "monid-from-env");
});

test("a cancelled signal still aborts, even when the service is failing", async () => {
  // The one case that must not fall through: the caller gave up, so spending
  // another lookup on their behalf is wrong.
  await assert.rejects(
    resolveApiKeyAsync("direct", {
      apiKeyEnv: "TINYFISH_API_KEY",
      signal: AbortSignal.abort("caller cancelled"),
      resolveCredential: async () => {
        throw new Error("service down");
      },
      env: { TINYFISH_API_KEY: "from-env" },
    }),
    (error) => error instanceof WebError && error.code === "WEB_ABORTED"
  );
});

test("no service, no ref: identical to the synchronous resolution", async () => {
  const key = await resolveApiKeyAsync("monid", {
    env: { MONID_API_KEY: "m" },
    credentialsPath: "/nope/absent",
  });
  assert.equal(key, "m");
});

/* ------------------------------------------------------------ request shape */

test("monid search posts the provider, endpoint and queryParams", async () => {
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([hit()]) }) }],
    async () =>
      tinyfishSearch({
        channel: "monid",
        apiKey: "k",
        query: "cloudflare d1",
        purpose: "why we are here",
        filters: {
          domain_type: "news",
          include_domains: "a.com",
          recency_minutes: 60,
        },
      })
  );
  const body = JSON.parse(nth(calls, 0, "request").init.body as string);
  assert.equal(body.provider, "tinyfish");
  assert.equal(body.endpoint, "/search");
  assert.deepEqual(body.input.queryParams, {
    query: "cloudflare d1",
    domain_type: "news",
    include_domains: "a.com",
    // Arrives here as a JSON number: upstream types it an integer, and the
    // monid envelope forwards `queryParams` verbatim.
    recency_minutes: 60,
    purpose: "why we are here",
  });
  assert.equal(nth(calls, 0, "request").url, `${DEFAULT_MONID_BASE}/v1/run`);
  assert.equal(nth(calls, 0, "request").headers.Authorization, "Bearer k");
});

test("direct search GETs the upstream with only non-empty params", async () => {
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: { results: [hit()] } }) }],
    async () =>
      tinyfishSearch({
        channel: "direct",
        apiKey: "k",
        query: "a b",
        purpose: "why we are here",
        filters: {
          language: "",
          // Deliberately untyped: the client must drop an `undefined` filter.
          location: undefined as unknown as string,
          after_date: "2026-01-01",
          recency_minutes: 60,
        },
      })
  );
  const url = new URL(nth(calls, 0, "request").url);
  assert.equal(url.origin, DEFAULT_SEARCH_BASE);
  assert.equal(url.searchParams.get("query"), "a b");
  assert.equal(url.searchParams.get("after_date"), "2026-01-01");
  assert.equal(
    url.searchParams.get("purpose"),
    "why we are here",
    "the goal statement rides search as well as fetch"
  );
  assert.equal(
    url.searchParams.get("recency_minutes"),
    "60",
    "the same integer the monid channel keeps as JSON, stringified here"
  );
  assert.equal(
    url.searchParams.has("language"),
    false,
    "empty string is dropped"
  );
  assert.equal(url.searchParams.has("location"), false, "undefined is dropped");
  assert.equal(nth(calls, 0, "request").headers["X-API-Key"], "k");
  assert.equal(nth(calls, 0, "request").headers.Authorization, undefined);
});

test("search drops a blank purpose instead of sending an empty param", async () => {
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: { results: [hit()] } }) }],
    async () =>
      tinyfishSearch({
        channel: "direct",
        apiKey: "k",
        query: "q",
        purpose: "",
      })
  );
  const url = new URL(nth(calls, 0, "request").url);
  assert.equal(
    url.searchParams.has("purpose"),
    false,
    "unset means no param, not an empty one"
  );
});

test("both channels send a browser user-agent, which Monid's Cloudflare requires", async () => {
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([hit()]) }) }],
    async () => tinyfishSearch({ channel: "monid", apiKey: "k", query: "q" })
  );
  const userAgent = nth(calls, 0, "request").headers["User-Agent"];
  assert.ok(userAgent, "the transport names its client");
  assert.match(userAgent, /Mozilla\/5\.0/);
});

test("monid fetch posts markdown format and the url list", async () => {
  const { calls } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope([{ url: "https://x", text: "hi" }]),
        }),
      },
    ],
    async () =>
      tinyfishFetch({
        channel: "monid",
        apiKey: "k",
        urls: ["https://x"],
        purpose: "why we are here",
        fetchOptions: {
          ttl: 0,
          per_url_timeout_ms: 30_000,
          exclude_selectors: ["nav", "footer"],
        },
      })
  );
  const body = JSON.parse(nth(calls, 0, "request").init.body as string);
  assert.equal(body.endpoint, "/fetch");
  assert.deepEqual(body.input.body, {
    urls: ["https://x"],
    format: "markdown",
    purpose: "why we are here",
    // `ttl: 0` is a real setting — force a live fetch — and must survive as
    // the number zero rather than be treated as an unset falsy.
    ttl: 0,
    per_url_timeout_ms: 30_000,
    exclude_selectors: ["nav", "footer"],
  });
});

test("direct fetch sends the identical body the monid channel wraps", async () => {
  const { calls } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: { results: [{ url: "https://x", text: "hi" }] },
        }),
      },
    ],
    async () =>
      tinyfishFetch({
        channel: "direct",
        apiKey: "k",
        urls: ["https://x"],
        fetchOptions: { ttl: 0, exclude_selectors: ["nav"] },
      })
  );
  assert.equal(nth(calls, 0, "request").url, DEFAULT_FETCH_BASE);
  assert.equal(nth(calls, 0, "request").headers["X-API-Key"], "k");
  const body = JSON.parse(nth(calls, 0, "request").init.body as string);
  assert.deepEqual(
    body,
    {
      urls: ["https://x"],
      format: "markdown",
      ttl: 0,
      exclude_selectors: ["nav"],
    },
    "one body builder serves both channels — the transport decides nothing"
  );
});

/* ------------------------------------------------------------- async polls */

test("a RUNNING envelope is polled until it settles", async () => {
  const { calls, result } = await withStubbedFetch(
    [
      { respond: () => ({ body: { runId: "r1", status: "RUNNING" } }) },
      { respond: () => ({ body: { runId: "r1", status: "RUNNING" } }) },
      { respond: () => ({ body: searchEnvelope([hit()]) }) },
    ],
    async () =>
      tinyfishSearch({
        channel: "monid",
        apiKey: "k",
        query: "q",
        pollMs: 1,
        delayMs: 1,
      })
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(nth(calls, 1, "request").init.body as string), {
    runId: "r1",
  });
  assert.equal(result.results?.length, 1);
});

test("a RUNNING fetch run is polled until it settles, like search", async () => {
  const { calls, result } = await withStubbedFetch(
    [
      { respond: () => ({ body: { runId: "r1", status: "RUNNING" } }) },
      { respond: () => ({ body: { runId: "r1", status: "RUNNING" } }) },
      { respond: () => ({ body: fetchEnvelope([{ url: "https://x" }]) }) },
    ],
    async () =>
      tinyfishFetch({
        channel: "monid",
        apiKey: "k",
        urls: ["https://x"],
        pollMs: 1,
        delayMs: 1,
      })
  );
  assert.equal(calls.length, 3, "one call per poll, then the one that settles");
  assert.deepEqual(JSON.parse(nth(calls, 1, "request").init.body as string), {
    runId: "r1",
  });
  assert.equal(result.results?.length, 1);
});

test("a settled operation leaves no listener on the caller's signal", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const counters = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ): void => {
      counters.added += 1;
      add(type, listener, options);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ): void => {
      counters.removed += 1;
      remove(type, listener, options);
    },
  });

  await abortable(Promise.resolve("ok"), signal);

  await withStubbedFetch(
    [
      { respond: () => ({ status: 500, text: "boom" }) },
      { respond: () => ({ body: searchEnvelope([hit()]) }) },
    ],
    async () =>
      tinyfishSearch({
        channel: "monid",
        apiKey: "k",
        query: "q",
        attempts: 2,
        delayMs: 1,
        signal,
      })
  );

  assert.ok(counters.added > 0, "both paths subscribe while a signal is live");
  assert.equal(
    counters.added,
    counters.removed,
    "and both take the subscription back off"
  );
});

/* ------------------------------------------------------------- retry policy */

test("an empty search is retried, because a blank result set is usually the flake", async () => {
  const { calls, result } = await withStubbedFetch(
    [
      { respond: () => ({ body: searchEnvelope([]) }) },
      { respond: () => ({ body: searchEnvelope([]) }) },
      { respond: () => ({ body: searchEnvelope([hit()]) }) },
    ],
    async () =>
      tinyfishSearch({
        channel: "monid",
        apiKey: "k",
        query: "q",
        attempts: 3,
        delayMs: 1,
      })
  );
  assert.equal(calls.length, 3, "two empties then a real answer");
  assert.equal(result.results?.length, 1);
});

test("retries are bounded, and a genuinely empty result still resolves", async () => {
  const { calls, result } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([]) }) }],
    async () =>
      tinyfishSearch({
        channel: "monid",
        apiKey: "k",
        query: "q",
        attempts: 3,
        delayMs: 1,
      })
  );
  assert.equal(calls.length, 3, "attempts is a ceiling, not a floor");
  assert.deepEqual(result.results, []);
});

test("a COMPLETED run with null output and a 5xx is treated as transient", async () => {
  const { calls, result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: {
            status: "COMPLETED",
            output: null,
            providerResponse: { httpStatus: 503 },
          },
        }),
      },
      { respond: () => ({ body: searchEnvelope([hit()]) }) },
    ],
    async () =>
      tinyfishSearch({
        channel: "monid",
        apiKey: "k",
        query: "q",
        attempts: 3,
        delayMs: 1,
      })
  );
  assert.equal(calls.length, 2, "the SERVICE_BUSY shape is retried");
  assert.equal(result.results?.length, 1);
});

test("exhausting retries on a persistent 5xx surfaces the last failure", async () => {
  await assert.rejects(
    withStubbedFetch(
      [
        {
          respond: () => ({
            body: {
              status: "COMPLETED",
              output: null,
              providerResponse: { httpStatus: 503 },
            },
          }),
        },
      ],
      async () =>
        tinyfishSearch({
          channel: "monid",
          apiKey: "k",
          query: "q",
          attempts: 2,
          delayMs: 1,
        })
    ).then((r) => r.result),
    (error) =>
      error instanceof WebError &&
      /temporarily unavailable/i.test(error.message)
  );
});

test("HTTP 429 from the direct API is retried", async () => {
  const { calls, result } = await withStubbedFetch(
    [
      { respond: () => ({ status: 429, text: "slow down" }) },
      { respond: () => ({ body: { results: [hit()] } }) },
    ],
    async () =>
      tinyfishSearch({
        channel: "direct",
        apiKey: "k",
        query: "q",
        attempts: 3,
        delayMs: 1,
      })
  );
  assert.equal(calls.length, 2);
  assert.equal(result.results?.length, 1);
});

/* ---------------------------------------------------------------- failures */

test("a BLOCKED run is terminal and names the top-up route", async () => {
  await assert.rejects(
    withStubbedFetch(
      [
        {
          respond: () => ({
            body: {
              status: "BLOCKED",
              reason: { reason: "budget exhausted", hints: ["raise the cap"] },
            },
          }),
        },
      ],
      async () =>
        tinyfishSearch({
          channel: "monid",
          apiKey: "k",
          query: "q",
          attempts: 5,
          delayMs: 1,
        })
    ).then((r) => r.result),
    (error) => {
      assert.ok(error instanceof WebError);
      assert.match(error.message, /budget exhausted/);
      assert.match(error.message, /raise the cap/);
      assert.match(error.message, /app\.monid\.ai\/wallet/);
      return true;
    }
  );
});

test("a BLOCKED run is not retried", async () => {
  const { calls } = await withStubbedFetch(
    [{ respond: () => ({ body: { status: "BLOCKED", reason: "nope" } }) }],
    async () => {
      await tinyfishSearch({
        channel: "monid",
        apiKey: "k",
        query: "q",
        attempts: 4,
        delayMs: 1,
      }).catch(() => {});
      return { ok: true };
    }
  );
  assert.equal(
    calls.length,
    1,
    "retrying a workspace block would just spend more"
  );
});

test("a FAILED run is terminal", async () => {
  await assert.rejects(
    withStubbedFetch(
      [{ respond: () => ({ body: { runId: "r", status: "FAILED" } }) }],
      async () => tinyfishSearch({ channel: "monid", apiKey: "k", query: "q" })
    ).then((r) => r.result),
    /ended FAILED/
  );
});

test("a rejected credential is terminal and names both channels' fixes", async () => {
  await assert.rejects(
    withStubbedFetch(
      [{ respond: () => ({ status: 401, text: "nope" }) }],
      async () =>
        tinyfishSearch({ channel: "monid", apiKey: "bad", query: "q" })
    ).then((r) => r.result),
    /rejected the monid API key/
  );
});

test("a rejection identifies which key was sent, without revealing it", async () => {
  // Several sources can supply the credential, so "your key is wrong" needs to
  // say which one. The fingerprint is a hash prefix: comparable against known
  // keys, useless to anyone who should not have them.
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256")
    .update("bad", "utf8")
    .digest("hex")
    .slice(0, 12);
  await assert.rejects(
    withStubbedFetch(
      [{ respond: () => ({ status: 403, text: "nope" }) }],
      async () =>
        tinyfishSearch({ channel: "monid", apiKey: "bad", query: "q" })
    ).then((r) => r.result),
    new RegExp(`key sha256:${expected}`)
  );
});

test("a non-JSON body is reported rather than swallowed", async () => {
  await assert.rejects(
    withStubbedFetch(
      [{ respond: () => ({ status: 200, invalidJson: true, text: "<html>" }) }],
      async () => tinyfishSearch({ channel: "monid", apiKey: "k", query: "q" })
    ).then((r) => r.result),
    /non-JSON/
  );
});

test("a missing credential fails with a routable code and a real fix", async () => {
  // The command in the message has to exist. These two did not at one point:
  // `monid login` is not a monid subcommand, and `tinyfish auth login` takes
  // no `--source` flag. A message naming a command that does not exist is
  // worse than no message, so the commands are asserted, not assumed.
  await assert.rejects(
    tinyfishSearch({
      channel: "direct",
      apiKey: "",
      query: "q",
      // Force the lookup to find nothing, whatever this machine has.
      tinyfishConfigPath: "/nope/absent",
      env: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebError);
      assert.equal(
        error.code,
        WEB_PROVIDER_CREDENTIAL_MISSING,
        "a missing key is routable, not an opaque provider error"
      );
      assert.match(error.message, /tinyfish auth login/);
      assert.doesNotMatch(error.message, /--source/, "no invented flags");
      assert.match(
        error.message,
        /Plugins → Tinyfish/,
        "the GUI path is named, not just CLI and env"
      );
      return true;
    }
  );
  await assert.rejects(
    tinyfishSearch({
      channel: "monid",
      apiKey: "",
      query: "q",
      credentialsPath: "/nope/absent",
      env: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebError);
      assert.equal(error.code, WEB_PROVIDER_CREDENTIAL_MISSING);
      assert.match(error.message, /monid keys add/);
      assert.doesNotMatch(
        error.message,
        /monid login/,
        "not a real subcommand"
      );
      assert.match(
        error.message,
        /Plugins → Tinyfish/,
        "the GUI path is named, not just CLI and env"
      );
      return true;
    }
  );
});

test("an aborted signal surfaces as WEB_ABORTED", async () => {
  await assert.rejects(
    tinyfishSearch({
      channel: "monid",
      apiKey: "k",
      query: "q",
      signal: AbortSignal.abort("caller cancelled"),
    }),
    (error) => error instanceof WebError && error.code === "WEB_ABORTED"
  );
});

test("the credential service is consulted on every search, never cached", async () => {
  // This is the property a future OAuth-backed ref depends on. A resolver that
  // returns a fresh token per call only works if the client actually calls it
  // per call. Pinning a key at module load or memoizing the first answer would
  // silently turn rotation — and any refresh flow — into a stale credential.
  let calls = 0;
  const keys = ["first-key", "rotated-key"];
  const options = {
    channel: "monid" as const,
    apiKeyEnv: "TINYFISH_API_KEY",
    monidKeyEnv: "MONID_API_KEY",
    resolveCredential: async (): Promise<string | undefined> => {
      const key = keys[Math.min(calls, 1)];
      calls += 1;
      return key;
    },
    credentialsPath: "/nope/absent",
  };
  assert.equal(await resolveApiKeyAsync("monid", options), "first-key");
  assert.equal(await resolveApiKeyAsync("monid", options), "rotated-key");
  assert.equal(calls, 2, "one service call per resolution");
});
