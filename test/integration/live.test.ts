/**
 * Live integration tests: the real TinyFish and Monid APIs.
 *
 * Skipped unless `DSH_TINYFISH_LIVE=1`, so `pnpm test` stays hermetic and
 * free. Both endpoints cost $0, so running this costs nothing either.
 *
 *   DSH_TINYFISH_LIVE=1 node --test test/integration/live.test.mjs
 *
 * What is asserted here is only what the stubbed suite cannot know: that both
 * channels really do return the same payload, and that the shapes the mappers
 * depend on still hold upstream.
 */

import assert from "node:assert/strict";

// Assertions stay on `node:assert` so that a failure here can only be the runner
// swap, never an assertion-library rewrite.
import { test } from "vitest";

import { resolveApiKey, type TinyfishChannel } from "../../src/client.ts";
import { resolveOptions } from "../../src/index.ts";
import {
  TinyfishFetchProvider,
  TinyfishSearchProvider,
  toIsoDate,
} from "../../src/provider.ts";

const LIVE = process.env.DSH_TINYFISH_LIVE === "1";

/**
 * Options built by the plugin's own resolver, not hand-rolled.
 *
 * This fixture used to be a literal, and it drifted: when `search` and `fetch`
 * were added to the schema the literal did not gain them, so `available()`
 * returned `undefined` from an untyped test and the live suite failed for a
 * reason that had nothing to do with either API. `resolveOptions` is the same
 * path the harness uses, so a new field cannot be forgotten here.
 */
const opts = (channel: TinyfishChannel) => () => ({
  ...resolveOptions({ channel }),
  apiKey: resolveApiKey(channel),
  delayMs: 1000,
  attempts: 3,
});

const QUERY = "cloudflare workers custom domain";

test(
  "monid channel: search returns usable sources",
  { skip: !LIVE },
  async () => {
    const provider = new TinyfishSearchProvider(opts("monid"));
    assert.equal(provider.available(), true, "a monid key is configured");
    const result = await provider.search({ query: QUERY });
    assert.ok(result.sources.length > 0, "upstream returned results");
    for (const source of result.sources) {
      assert.match(source.url, /^https?:\/\//);
      if (source.publishedAt)
        assert.ok(!Number.isNaN(Date.parse(source.publishedAt)));
    }
  }
);

test(
  "direct channel: search returns usable sources",
  { skip: !LIVE },
  async () => {
    const provider = new TinyfishSearchProvider(opts("direct"));
    assert.equal(provider.available(), true, "a tinyfish key is configured");
    const result = await provider.search({ query: QUERY });
    assert.ok(result.sources.length > 0);
  }
);

test(
  "both channels agree on the top hit for one query",
  { skip: !LIVE },
  async () => {
    // The whole reason the two channels share a code path: Monid's `output` is
    // TinyFish's response verbatim. If that stops being true, this fails first.
    const monid = await new TinyfishSearchProvider(opts("monid")).search({
      query: QUERY,
    });
    const direct = await new TinyfishSearchProvider(opts("direct")).search({
      query: QUERY,
    });
    assert.ok(monid.sources[0], "the monid channel answered with a hit");
    assert.ok(direct.sources[0], "the direct channel answered with a hit");
    assert.equal(monid.sources[0].url, direct.sources[0].url);
  }
);

test(
  "fetch returns markdown text on both channels",
  { skip: !LIVE },
  async () => {
    for (const channel of ["monid", "direct"] as const) {
      const provider = new TinyfishFetchProvider(opts(channel));
      const page = await provider.fetch({ url: "https://example.com" });
      assert.equal(page.statusCode, 200, `${channel}: example.com is 200`);
      assert.equal(page.body.kind, "text", `${channel}: markdown, not html`);
      assert.ok(page.body.content.length > 0, `${channel}: body is not empty`);
      assert.doesNotMatch(
        page.body.content,
        /<html/i,
        `${channel}: markup is stripped`
      );
    }
  }
);

test(
  "a 404 comes back as a result on both channels",
  { skip: !LIVE },
  async () => {
    for (const channel of ["monid", "direct"] as const) {
      const provider = new TinyfishFetchProvider(opts(channel));
      const page = await provider.fetch({
        url: "https://example.com/definitely-not-a-real-404",
      });
      assert.equal(
        page.statusCode,
        404,
        `${channel}: 404 is reported, not thrown`
      );
    }
  }
);

test(
  "upstream date strings are still human-form, so coercion still matters",
  { skip: !LIVE },
  async () => {
    const raw = await fetch(
      `https://api.search.tinyfish.ai?${new URLSearchParams({ query: QUERY }).toString()}`,
      { headers: { "X-API-Key": resolveApiKey("direct") } }
    ).then(async (r) => r.json());
    const dated = (raw.results ?? []).find(
      (r: { date?: unknown }) => typeof r.date === "string"
    );
    assert.ok(dated, "the response carries at least one date string");
    const iso = toIsoDate(dated.date);
    // Unconditional: the old `if (iso)` guard skipped this check whenever the
    // coercion returned nothing — which is exactly when coercion is broken,
    // the case this test exists to catch.
    assert.ok(iso, "the human-form date coerces to an ISO string");
    assert.ok(!Number.isNaN(Date.parse(iso)), "coerced dates parse");
  }
);
