/**
 * Plugin-surface tests: the cordis contract and the config normalisation.
 *
 * A DSH bundle is a package that declares a patch file, so what is worth
 * pinning is that the exports are shaped the way the loader expects, that
 * `apply` registers both providers on `ctx.web`, and that a bad config value
 * is clamped rather than trusted.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
// Assertions stay on `node:assert` so that a failure here can only be the runner
// swap, never an assertion-library rewrite.
import { test } from "vitest";

import * as plugin from "../src/index.ts";
import type { TinyfishProviderOptions } from "../src/provider.ts";

/** Read a validated schema node, or pass a plain value through. */
const readNode = (node: unknown): unknown =>
  typeof node === "object" &&
  node !== null &&
  "get" in node &&
  typeof (node as { get: unknown }).get === "function"
    ? (node as { get: () => unknown }).get()
    : node;

/** A provider the stub registry records. */
interface StubProvider {
  readonly id: string;
  resolveOptions: () => TinyfishProviderOptions;
}

/** What the stub registry records. */
interface StubRegistry {
  search: StubProvider;
  fetch: StubProvider;
}

/** The stub context: just `web`, plus an optional `get` for service tests. */
interface StubContext {
  web: {
    registerSearchProvider: (provider: StubProvider) => void;
    registerFetchProvider: (provider: StubProvider) => void;
  };
  get?: (service: string) => unknown;
}

/** Minimal `ctx.web` stub that records what gets registered. */
function stubContext(): { registered: StubRegistry; ctx: StubContext } {
  const registered = {} as StubRegistry;
  return {
    registered,
    ctx: {
      web: {
        registerSearchProvider: (p: StubProvider): void => {
          registered.search = p;
        },
        registerFetchProvider: (p: StubProvider): void => {
          registered.fetch = p;
        },
      },
    },
  };
}

test("the bundle exports what a cordis plugin must", () => {
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual(
    plugin.inject,
    ["web"],
    "it needs the web service and nothing else"
  );
  assert.equal(plugin.name, "dsh-tinyfish");
  assert.equal(plugin.TINYFISH_PROVIDER_ID, "tinyfish");
});

test("the bundle patch is additive and names no protected package", () => {
  // A bundle may insert its own rows. Reaching into another package's row —
  // naming the web package so as to set `searchProvider` / `fetchProvider` — is
  // a bundle choosing a provider for the host, and a patch-safety check reads
  // it as impersonating a protected entry. Selection belongs to the profile,
  // so the patch file must not carry the protected scope at all, comments
  // included: a scanner cannot be relied on to skip them.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  assert.ok(
    !patch.includes("@deepseek-ai/"),
    "the bundle patch must name no protected package or entry"
  );
  // It still does its own job: insert the plugin's row under its own id, and
  // leave selection to a layer that owns the decision.
  assert.match(patch, /-\s*insert:/, "the patch inserts the plugin's row");
  assert.match(patch, /id:\s*dsh-tinyfish/, "and that row is the plugin's own");
  assert.ok(
    !/searchProvider|fetchProvider/.test(patch.replaceAll(/^#.*$/gm, "")),
    "and it selects nothing, since selection is the profile's decision"
  );
});

test("it exports a schemastery Config, so the row renders as a settings section", () => {
  // Cordis resolves a plugin's Config and falls back to the raw row when one is
  // absent, so exporting it is the difference between a real settings section
  // and free-form YAML the user has to get right by hand.
  //
  // It is the harness's own @deepseek-ai/schemastery fork, not the public
  // package: the fork carries `.role()`, `.volatile()` and `.get()`, and
  // the public 3.18.x line does not.
  assert.ok(plugin.Config, "Config is exported");

  // A validated section hands back schema nodes, not plain values — the
  // harness reads them with `.get()`. Reading a defaulted field as a bare
  // property yields the node itself, which is why every read goes through the
  // same accessor.
  const validated = plugin.Config({});
  assert.equal(
    readNode(validated.channel),
    "direct",
    "defaults applied by the schema"
  );
  assert.equal(readNode(validated.attempts), 3);
  assert.equal(readNode(validated.apiKeyEnv), "TINYFISH_API_KEY");
  assert.equal(readNode(validated.monidBase), "https://api.monid.ai");
});

test("the Config schema accepts both channels and rejects a third", () => {
  assert.equal(plugin.Config({ channel: "direct" }).channel, "direct");
  assert.equal(plugin.Config({ channel: "monid" }).channel, "monid");
  assert.equal(
    plugin.Config({}).channel,
    "direct",
    "unset falls back, never undefined"
  );
  assert.throws(
    () => plugin.Config({ channel: "carrier-pigeon" as unknown as "direct" }),
    "rejects an unknown channel"
  );
});

test("the Config schema rejects attempts outside the retry loop's range", () => {
  // Rejecting is better than clamping: a silently clamped `attempts: 99` looks
  // applied and is not, and the user has no way to notice. `resolveOptions`
  // still clamps, because a raw patch row can reach it without validation.
  assert.equal(readNode(plugin.Config({ attempts: 4 }).attempts), 4);
  assert.throws(() => plugin.Config({ attempts: 0 }), />= 1/);
  assert.throws(() => plugin.Config({ attempts: 99 }), /<= 5/);
});

test("resolveOptions still clamps, for a row that skipped validation", () => {
  assert.equal(plugin.resolveOptions({ attempts: 0 }).attempts, 1);
  assert.equal(plugin.resolveOptions({ attempts: 99 }).attempts, 5);
  assert.equal(plugin.resolveOptions({ attempts: 2.7 }).attempts, 2, "floored");
  assert.equal(plugin.resolveOptions({ attempts: "nope" }).attempts, 3);
});

test("an unknown key is preserved rather than stripped, so a typo is visible", () => {
  // schemastery is permissive by design here: silently dropping a misspelled
  // field would make a config that looks applied and is not.
  const validated = plugin.Config({ channel: "monid", channelTypo: "direct" });
  assert.equal(validated.channel, "monid");
  assert.equal(validated.channelTypo, "direct");
});

test("apply registers both seam kinds under one id", () => {
  const { ctx, registered } = stubContext();
  plugin.apply(ctx as unknown as Context, {});
  assert.ok(registered.search, "search provider registered");
  assert.ok(registered.fetch, "fetch provider registered");
  assert.equal(registered.search.id, "tinyfish");
  assert.equal(registered.fetch.id, "tinyfish");
});

test("apply works with no config at all", () => {
  const { ctx, registered } = stubContext();
  plugin.apply(ctx as unknown as Context);
  assert.equal(registered.search.id, "tinyfish");
});

test("config: channel defaults to direct, and accepts monid explicitly", () => {
  // `direct` is the default because the package is named for TinyFish: a fresh
  // install should ask for the credential its own name implies, not for an
  // account at a different service. A host that prefers the Monid envelope
  // pins it in its own patch layer, which is why the "unset" cases below land
  // on `direct` and not on the channel a user might have preferred.
  assert.equal(plugin.resolveOptions(undefined).channel, "direct");
  assert.equal(plugin.resolveOptions({ channel: "monid" }).channel, "monid");
  assert.equal(plugin.resolveOptions({ channel: "direct" }).channel, "direct");

  // An unset, empty or garbled value must take the same path as the schema
  // default. This is the inverted branch that makes that true: anything that is
  // not an explicit "monid" is "direct".
  assert.equal(
    plugin.resolveOptions({ channel: "nonsense" }).channel,
    "direct"
  );
  assert.equal(plugin.resolveOptions({ channel: "" }).channel, "direct");
  assert.equal(plugin.resolveOptions({ channel: null }).channel, "direct");
  assert.equal(
    plugin.resolveOptions(plugin.Config({})).channel,
    "direct",
    "a validated row with no channel agrees with a raw one"
  );
  assert.equal(
    plugin.resolveOptions(plugin.Config({ channel: "monid" })).channel,
    "monid",
    "an explicit monid survives validation"
  );
});

test("config: attempts is clamped to the range the retry loop honours", () => {
  assert.equal(plugin.resolveOptions(undefined).attempts, 3);
  assert.equal(plugin.resolveOptions({ attempts: 0 }).attempts, 1);
  assert.equal(plugin.resolveOptions({ attempts: 1 }).attempts, 1);
  assert.equal(plugin.resolveOptions({ attempts: 5 }).attempts, 5);
  assert.equal(plugin.resolveOptions({ attempts: 99 }).attempts, 5);
  assert.equal(plugin.resolveOptions({ attempts: "nope" }).attempts, 3);
  assert.equal(plugin.resolveOptions({ attempts: 2.7 }).attempts, 2, "floored");
});

test("config: base URLs have defaults and accept overrides", () => {
  const d = plugin.resolveOptions(undefined);
  assert.equal(d.monidBase, "https://api.monid.ai");
  assert.equal(d.searchBase, "https://api.search.tinyfish.ai");
  assert.equal(d.fetchBase, "https://api.fetch.tinyfish.ai");
  const o = plugin.resolveOptions({ monidBase: "https://monid.internal" });
  assert.equal(o.monidBase, "https://monid.internal");
  assert.equal(
    o.searchBase,
    "https://api.search.tinyfish.ai",
    "one override leaves the rest"
  );
});

test("config: harness camelCase filters become upstream snake_case", () => {
  const o = plugin.resolveOptions({
    filters: {
      domainType: "news",
      language: "en",
      location: "US",
      includeDomains: "a.com,b.com",
      excludeDomains: "c.com",
    },
  });
  assert.deepEqual(o.filters, {
    domain_type: "news",
    language: "en",
    location: "US",
    include_domains: "a.com,b.com",
    exclude_domains: "c.com",
  });
});

test("config: empty and absent filters contribute nothing", () => {
  assert.deepEqual(plugin.resolveOptions(undefined).filters, {});
  assert.deepEqual(plugin.resolveOptions({ filters: {} }).filters, {});
  assert.deepEqual(
    plugin.resolveOptions({ filters: { language: "", location: undefined } })
      .filters,
    {},
    "blank values are not sent upstream"
  );
});

test("config: a blank apiKey resolves to undefined, not an empty string", () => {
  assert.equal(plugin.resolveOptions({ apiKey: "" }).apiKey, undefined);
  assert.equal(plugin.resolveOptions({ apiKey: "  " }).apiKey, undefined);
  assert.equal(plugin.resolveOptions({ apiKey: "k" }).apiKey, "k");
});

test("the options thunk re-reads config on each call, so a settings change takes effect", () => {
  // Re-registering the provider to carry new config would make the seam's
  // selection flicker for the user; a thunk keeps one registration live.
  const { ctx, registered } = stubContext();
  const config = { channel: "monid" };
  const originalApply = plugin.apply;
  // Re-apply with a mutable config object to observe the thunk's behaviour.
  assert.equal(typeof originalApply, "function");
  originalApply(ctx as unknown as Context, config);
  const before = registered.search.resolveOptions().channel;
  config.channel = "direct";
  const after = registered.search.resolveOptions().channel;
  assert.equal(before, "monid");
  assert.equal(after, "direct", "the thunk closes over the config object");
});

test("the credentials service is wired, not merely accepted", async () => {
  // Regression guard for a real defect: `resolveCredential` was a declared
  // option that nothing in `apply` ever supplied, so the documented
  // integration with the harness credentials service did not exist at all.
  // The plugin must build the lookup from `ctx` and hand it to the providers.
  const asked: string[] = [];
  let provider: StubProvider | undefined;
  const ctx = {
    get: (
      service: string
    ):
      | {
          resolve: (ref: string) => Promise<{ value: string; source: string }>;
        }
      | undefined =>
      service === "credentials"
        ? {
            resolve: async (ref: string) => {
              asked.push(ref);
              return { value: "stored-key", source: "file" };
            },
          }
        : undefined,
    web: {
      registerSearchProvider: (p: StubProvider): void => {
        provider = p;
      },
      registerFetchProvider: (): void => {},
    },
  };

  plugin.apply(ctx as unknown as Context, { apiKeyEnv: "TINYFISH_API_KEY" });
  assert.ok(provider, "a search provider was registered");

  const resolver = provider.resolveOptions().resolveCredential;
  assert.equal(typeof resolver, "function", "the lookup was built from ctx");
  assert.equal(await resolver?.("TINYFISH_API_KEY"), "stored-key");
  assert.equal(asked.length, 1, "the host service was actually called");
});

test("a ctx with no credentials service still loads", () => {
  // Registration must not fail because an optional service is absent: the
  // client then falls through to the environment and the CLI stores.
  const { ctx } = stubContext();
  ctx.get = () => {};
  assert.doesNotThrow(() => {
    plugin.apply(ctx as unknown as Context, {});
  });
});

test("a ctx with no get at all still loads", () => {
  const { ctx } = stubContext();
  assert.doesNotThrow(() => {
    plugin.apply(ctx as unknown as Context, {});
  });
});

test("both providers share one config view", () => {
  const { ctx, registered } = stubContext();
  plugin.apply(ctx as unknown as Context, { channel: "direct", attempts: 2 });
  assert.equal(registered.search.resolveOptions().channel, "direct");
  assert.equal(registered.fetch.resolveOptions().channel, "direct");
  assert.equal(registered.fetch.resolveOptions().attempts, 2);
});

test("the client surface is re-exported for consumers and tests", () => {
  for (const name of [
    "resolveApiKey",
    "tinyfishSearch",
    "tinyfishFetch",
    // The seam's own error, re-exported so consumers can narrow on it without
    // depending on @deepseek-ai/dsh-web directly.
    "WebError",
    "TINYFISH_PROVIDER_ID",
    "TinyfishSearchProvider",
    "TinyfishFetchProvider",
    "toIsoDate",
    "resolveOptions",
  ] as const) {
    assert.ok(plugin[name] !== undefined, `${name} is exported`);
  }
});
