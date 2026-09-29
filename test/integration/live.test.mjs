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
import test from "node:test";

import { resolveApiKey } from "../../src/client.ts";
import {
  TinyfishFetchProvider,
  TinyfishSearchProvider,
  toIsoDate,
} from "../../src/provider.ts";

const LIVE = process.env.DSH_TINYFISH_LIVE === "1";
const opts = (channel) => () => ({
  channel,
  apiKey: resolveApiKey(channel),
  filters: {},
  attempts: 3,
  delayMs: 1000,
  monidBase: "https://api.monid.ai",
  searchBase: "https://api.search.tinyfish.ai",
  fetchBase: "https://api.fetch.tinyfish.ai",
});

const QUERY = "cloudflare workers custom domain";

test(
  "monid channel: search returns usable sources",
  { skip: !LIVE },
  async () => {
    const provider = new TinyfishSearchProvider(opts("monid"));
    assert.equal(provider.available(), true, "a monid key is configured");
    const result = await provider.search({ query: QUERY }, undefined);
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
    const result = await provider.search({ query: QUERY }, undefined);
    assert.ok(result.sources.length > 0);
  }
);

test(
  "both channels agree on the top hit for one query",
  { skip: !LIVE },
  async () => {
    // The whole reason the two channels share a code path: Monid's `output` is
    // TinyFish's response verbatim. If that stops being true, this fails first.
    const monid = await new TinyfishSearchProvider(opts("monid")).search(
      { query: QUERY },
      undefined
    );
    const direct = await new TinyfishSearchProvider(opts("direct")).search(
      { query: QUERY },
      undefined
    );
    assert.equal(monid.sources[0].url, direct.sources[0].url);
  }
);

test(
  "fetch returns markdown text on both channels",
  { skip: !LIVE },
  async () => {
    for (const channel of ["monid", "direct"]) {
      const provider = new TinyfishFetchProvider(opts(channel));
      const page = await provider.fetch(
        { url: "https://example.com" },
        undefined
      );
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
    for (const channel of ["monid", "direct"]) {
      const provider = new TinyfishFetchProvider(opts(channel));
      const page = await provider.fetch(
        { url: "https://example.com/definitely-not-a-real-404" },
        undefined
      );
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
    ).then((r) => r.json());
    const dated = (raw.results ?? []).find((r) => typeof r.date === "string");
    assert.ok(dated, "the response carries at least one date string");
    const iso = toIsoDate(dated.date);
    if (iso) assert.ok(!Number.isNaN(Date.parse(iso)), "coerced dates parse");
  }
);
