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

// Assertions stay on `node:assert` so that a failure here can only be the runner
// swap, never an assertion-library rewrite.
import { test } from "vitest";

import { TinyfishFetchProvider, TinyfishSearchProvider, toIsoDate } from "../src/provider.ts";
import { fetchEnvelope, hit, searchEnvelope, withStubbedFetch } from "./helpers.mjs";

const OPTIONS = {
  channel: "monid",
  apiKey: "k",
  apiKeyEnv: "TINYFISH_API_KEY",
  filters: {},
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
  assert.equal(toIsoDate("2026-04-30T12:00:00+02:00"), "2026-04-30T10:00:00.000Z");
});

test("toIsoDate: relative and unparseable values are dropped, not guessed", () => {
  assert.equal(toIsoDate("1 year ago"), undefined);
  assert.equal(toIsoDate("yesterday"), undefined);
  assert.equal(toIsoDate(""), undefined);
  assert.equal(toIsoDate("   "), undefined);
  assert.equal(toIsoDate(undefined), undefined);
  assert.equal(toIsoDate(12345), undefined, "a non-string is not a date");
});

/* ------------------------------------------------------------------ search */

test("search maps results into citeable sources", async () => {
  const { result } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([hit()]) }) }],
    () => search().search({ query: "q" }),
  );
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0], {
    url: "https://example.com/page",
    title: "A title",
    snippet: "A snippet",
    publishedAt: "2026-04-30T00:00:00.000Z",
  });
  assert.equal(result.truncated, false, "the seam owns truncation, not the provider");
  assert.equal(result.content, undefined, "tinyfish ranks, it does not generate an answer");
});

test("search omits fields the payload did not supply", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: searchEnvelope([{ url: "https://x", title: "T", date: "1 year ago" }]),
        }),
      },
    ],
    () => search().search({ query: "q" }),
  );
  assert.deepEqual(result.sources[0], { url: "https://x", title: "T" });
});

test("search drops hits with no url rather than emitting an uncitable source", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: searchEnvelope([hit(), { title: "orphan" }, hit({ url: "https://b" })]),
        }),
      },
    ],
    () => search().search({ query: "q" }),
  );
  assert.deepEqual(
    result.sources.map((s) => s.url),
    ["https://example.com/page", "https://b"],
  );
});

test("search accepts `description` as an alias for `snippet`", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: searchEnvelope([{ url: "https://x", title: "T", description: "D" }]),
        }),
      },
    ],
    () => search().search({ query: "q" }),
  );
  assert.equal(result.sources[0].snippet, "D");
});

test("search returns no sources when the upstream genuinely has none", async () => {
  const { result } = await withStubbedFetch(
    [{ respond: () => ({ body: searchEnvelope([]) }) }],
    () => search().search({ query: "q" }),
  );
  assert.deepEqual(result.sources, []);
  assert.equal(result.truncated, false);
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
    () => fetchp().fetch({ url: "https://x" }),
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
          body: fetchEnvelope([{ url: "https://x", final_url: "https://y", text: "t" }]),
        }),
      },
    ],
    () => fetchp().fetch({ url: "https://x" }),
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
          body: fetchEnvelope([], [{ url: "https://x", error: "page_not_found", status: 404 }]),
        }),
      },
    ],
    () => fetchp().fetch({ url: "https://x" }),
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
            [{ url: "https://other", error: "boom", status: 500 }],
          ),
        }),
      },
    ],
    () => fetchp().fetch({ url: "https://wanted" }),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.content, "ok");
});

test("a trailing slash does not stop a fetch error from matching its request", async () => {
  const { result } = await withStubbedFetch(
    [
      {
        respond: () => ({
          body: fetchEnvelope([], [{ url: "https://x/", error: "gone", status: 410 }]),
        }),
      },
    ],
    () => fetchp().fetch({ url: "https://x" }),
  );
  assert.equal(result.statusCode, 410);
});

test("neither a result nor an error is a provider fault, and throws", async () => {
  await assert.rejects(
    withStubbedFetch([{ respond: () => ({ body: fetchEnvelope([], []) }) }], () =>
      fetchp().fetch({ url: "https://x" }),
    ).then((r) => r.result),
    (error) => /returned no content/.test(error.message),
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
    () => fetchp().fetch({ url: "https://x" }),
  );
  assert.equal(result.statusCode, 502, "an unstatusable failure is a bad gateway");
});

test("empty page text is still a result, not a failure", async () => {
  const { result } = await withStubbedFetch(
    [{ respond: () => ({ body: fetchEnvelope([{ url: "https://x" }]) }) }],
    () => fetchp().fetch({ url: "https://x" }),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.content, "");
});
