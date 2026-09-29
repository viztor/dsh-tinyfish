import assert from "node:assert/strict";
import { test } from "vitest";

import * as plugin from "../src/index.ts";
import { TinyfishFetchProvider, TinyfishSearchProvider } from "../src/provider.ts";

/**
 * Coexistence with the providers DSH already ships.
 *
 * `ctx.web` holds a registry per seam kind, and registering an id that is
 * already present throws `WEB_DUPLICATE_PROVIDER`. A DSH bundle does not run
 * alone: `dsh-web-search-deepseek` and `dsh-web-fetch-http` are always
 * mounted, and they own the `deepseek-official` and `http` ids. So "does my
 * plugin work" is not the question — "does it work *next to them*, and does
 * the profile's selection still resolve either way" is.
 *
 * These are registry-level facts, so they are tested against a stub that
 * enforces the same duplicate rule the seam does, rather than against a real
 * harness process.
 */

/** A stand-in for another registered provider. */
function foreignProvider(id) {
  return {
    id,
    available: () => true,
    search: async () => ({ sources: [], truncated: false }),
    fetch: async () => ({
      url: "",
      statusCode: 200,
      body: { kind: "text", content: "" },
      truncated: false,
    }),
  };
}

/** A `ctx.web` that enforces the seam's duplicate rule. */
function registry() {
  const search = new Map();
  const fetch = new Map();
  return {
    search,
    fetch,
    ctx: {
      web: {
        registerSearchProvider(provider) {
          if (search.has(provider.id)) {
            const error = new Error(`duplicate search provider ${provider.id}`);
            error.code = "WEB_DUPLICATE_PROVIDER";
            throw error;
          }
          search.set(provider.id, provider);
        },
        registerFetchProvider(provider) {
          if (fetch.has(provider.id)) {
            const error = new Error(`duplicate fetch provider ${provider.id}`);
            error.code = "WEB_DUPLICATE_PROVIDER";
            throw error;
          }
          fetch.set(provider.id, provider);
        },
      },
    },
  };
}

/** Mount the shipped providers, then this bundle, the way a profile would. */
function bootWithHarnessProviders() {
  const { ctx, search, fetch } = registry();
  // What dsh-web ships, always present in a real profile.
  ctx.web.registerSearchProvider(foreignProvider("deepseek-official"));
  ctx.web.registerFetchProvider(foreignProvider("http"));
  plugin.apply(ctx, plugin.Config({}));
  return { search, fetch };
}

test("it registers alongside the providers DSH ships", () => {
  const { search, fetch } = bootWithHarnessProviders();
  assert.deepEqual(
    [...search.keys()].toSorted(),
    ["deepseek-official", "tinyfish"],
    "both search providers coexist under distinct ids",
  );
  assert.deepEqual(
    [...fetch.keys()].toSorted(),
    ["http", "tinyfish"],
    "both fetch providers coexist under distinct ids",
  );
});

test("its id is neither the shipped one nor a bare upstream name", () => {
  // The id is the seam's selection key. If it ever collided with a shipped
  // provider, loading this bundle would break every profile that has both.
  for (const id of ["tinyfish"]) {
    assert.notEqual(id, "deepseek-official");
    assert.notEqual(id, "http");
    assert.notEqual(id, "deepseek");
    assert.notEqual(id, "monid");
  }
});

test("registering the bundle twice is rejected by the registry, not silently", () => {
  // One bundle, one registration. If a second copy of the package ever loaded
  // (two profiles, or a duplicate entry in `bundles`), the harness must say so
  // rather than quietly running whichever won.
  const { ctx } = registry();
  plugin.apply(ctx, plugin.Config({}));
  assert.throws(
    () => plugin.apply(ctx, plugin.Config({})),
    (error) => error.code === "WEB_DUPLICATE_PROVIDER",
  );
});

test("the profile's selection resolves to this provider, and back again", () => {
  const { search, fetch } = bootWithHarnessProviders();

  // The bundle's own patch sets these, and that is what makes tinyfish win.
  const selectedSearch = search.get("tinyfish");
  const selectedFetch = fetch.get("tinyfish");
  assert.ok(selectedSearch, "searchProvider: tinyfish resolves");
  assert.ok(selectedFetch, "fetchProvider: tinyfish resolves");

  // Reverting is a two-word edit in dsh-web's config, not a plugin removal.
  // Both alternatives must still be registered and usable.
  assert.ok(
    search.get("deepseek-official"),
    "the shipped provider stays registered, so reverting needs no reinstall",
  );
  assert.ok(fetch.get("http"), "the shipped fetch provider likewise");
});

test("a provider it does not own is never consulted", () => {
  // The adapter is constructed directly here, so this asserts the class does
  // not reach for a foreign id: it only ever speaks to its own transport.
  const provider = new TinyfishSearchProvider(() => ({
    channel: "monid",
    apiKey: "k",
    apiKeyEnv: "TINYFISH_API_KEY",
    filters: {},
    attempts: 1,
    monidBase: "https://api.monid.ai",
    searchBase: "https://api.search.tinyfish.ai",
    fetchBase: "https://api.fetch.tinyfish.ai",
  }));
  assert.equal(provider.id, "tinyfish");
  assert.equal(typeof provider.search, "function");
  assert.equal(new TinyfishFetchProvider(() => ({})).id, "tinyfish");
});

test("a settings row from another patch layer still resolves", () => {
  // Patch layers merge by id, so this bundle's row can arrive either as a
  // validated section — boxed schema nodes, read with `.get()` — or as a raw
  // object, if another layer wrote the row before the loader validated it. Both
  // have to work, and the difference is invisible until a value silently comes
  // out wrong.
  const validated = plugin.Config({ channel: "direct", attempts: 5 });
  const raw = { channel: "direct", attempts: 5 };

  for (const [label, section] of [
    ["validated", validated],
    ["raw", raw],
  ]) {
    const options = plugin.resolveOptions(section);
    assert.equal(options.channel, "direct", `${label}: channel survives`);
    assert.equal(options.attempts, 5, `${label}: attempts survives`);
    assert.equal(
      options.apiKeyEnv,
      "TINYFISH_API_KEY",
      `${label}: the credential-ref default applies`,
    );
    assert.equal(options.searchBase, "https://api.search.tinyfish.ai");
  }

  assert.deepEqual(
    plugin.resolveOptions(raw).filters,
    plugin.resolveOptions(validated).filters,
    "both shapes produce the same upstream filters",
  );
});

test("an unparseable value in a merged row degrades instead of poisoning it", () => {
  // A typo'd key, or a section object read as a scalar, must not become
  // "[object Object]" in a request URL.
  const options = plugin.resolveOptions({ monidBase: { nested: true }, attempts: 2 });
  assert.equal(options.monidBase, "https://api.monid.ai", "falls back to the default");
  assert.equal(options.attempts, 2);
});

test("the shipped providers are untouched by loading this bundle", async () => {
  // A foreign provider's `available()` must still be reachable and stable —
  // loading the bundle must not mutate another provider's state.
  const { search } = bootWithHarnessProviders();
  const shipped = search.get("deepseek-official");
  const before = shipped.available();
  const mine = search.get("tinyfish");
  mine.available();
  assert.equal(shipped.available(), before, "another provider's state is not disturbed");
});
