/**
 * Configuration, specified in one place.
 *
 * Every other test file exercises the code that *uses* the config. Nothing
 * stated what the config *is* — so a field could be added to the schema and
 * never threaded through `resolveOptions`, and it would be silently inert, the
 * same class of defect as the `attempts` bug where a validated row's boxed node
 * read as `NaN` and quietly took the default.
 *
 * Three things are pinned here:
 *
 *   1. **Every schema field has a row** in the table below. The table is checked
 *      against the schema's own key list, so adding a field without deciding its
 *      default and its garbage behaviour fails rather than passing quietly.
 *   2. **The whole credential precedence chain**, one rung at a time, with the
 *      rungs above it disabled. Individual rungs were tested; the order was
 *      not, and the order is the part that decides which key is used.
 *   3. **Layer precedence** — a host patch row overriding the bundle's default
 *      is the thing that makes a preference a preference rather than a release.
 *
 * Hermetic: no network, no credentials, no real store paths.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, test } from "vitest";

import { resolveApiKey, resolveApiKeyAsync } from "../src/client.ts";
import { Config, apply, resolveOptions } from "../src/index.ts";

/* --------------------------------------------------------------- helpers */

const scratch = mkdtempSync(join(tmpdir(), "dsh-config-"));
const store = (name, body) => {
  const path = join(scratch, name);
  writeFileSync(path, body);
  return path;
};

const missing = join(scratch, "absent.yaml");
const monidStore = store(
  "monid.yaml",
  "keys:\n  main:\n    key: from_monid_store\n"
);
const tinyfishStore = store(
  "tinyfish.json",
  JSON.stringify({ api_key: "from_tinyfish_store" })
);

/* --------------------------------------------------- 1. the field contract */

/**
 * `default` is what an unset row yields, `junk` what an unusable value yields,
 * and `set` a distinct valid value that must round-trip. The table is checked
 * against the schema's own key list, so a field added to the schema without a
 * row here fails rather than passing quietly.
 */
const FIELDS = [
  { name: "channel", default: "direct", set: "monid", junk: "direct" },
  {
    name: "apiKeyEnv",
    default: "TINYFISH_API_KEY",
    set: "OTHER_KEY",
    junk: "TINYFISH_API_KEY",
  },
  {
    // The monid channel's own ref, as its own field rather than a second
    // possible value of `apiKeyEnv`, so a user can save both keys at once.
    name: "monidKeyEnv",
    default: "MONID_API_KEY",
    set: "MY_PLATFORM_KEY",
    junk: "MONID_API_KEY",
  },
  // `purpose` is the field that needed the `set` column. Its default and its
  // junk behaviour are both `undefined`, so a `purpose` dropped from the
  // resolver satisfies every other assertion in this test — and a field that is
  // declared but never threaded through is exactly the defect this file exists
  // to catch.
  { name: "purpose", default: undefined, set: "find pricing", junk: undefined },
  { name: "attempts", default: 3, set: 5, junk: 3 },
  { name: "search", default: true, set: false, junk: true },
  { name: "fetch", default: true, set: false, junk: true },
  {
    name: "monidBase",
    default: "https://api.monid.ai",
    set: "https://alt.example",
    junk: "https://api.monid.ai",
  },
  {
    name: "searchBase",
    default: "https://api.search.tinyfish.ai",
    set: "https://alt.example",
    junk: "https://api.search.tinyfish.ai",
  },
  {
    name: "fetchBase",
    default: "https://api.fetch.tinyfish.ai",
    set: "https://alt.example",
    junk: "https://api.fetch.tinyfish.ai",
  },
];

test("every schema field has a stated default and a stated junk behaviour", () => {
  // Driven off the schema itself: `Config({})` is a validated section, and a
  // validated section carries a node for every key the schema declares.
  const validated = Config({});
  const declared = Object.keys(validated).toSorted();

  assert.deepEqual(
    declared.filter((k) => k !== "apiKey" && k !== "filters"),
    FIELDS.map((f) => f.name).toSorted(),
    "the table covers the schema exactly — a new field must be given a default here"
  );

  // The switches are booleans, and their junk case is the interesting one: a
  // schema that yields the string "false" for an unset switch must not read as
  // false, or a malformed row would silently switch a provider off.
  assert.equal(
    resolveOptions({ search: "false" }).search,
    false,
    "an explicit false switches off"
  );
  assert.equal(
    resolveOptions({ search: "" }).search,
    true,
    "blank is not false"
  );
  assert.equal(
    resolveOptions({ search: "no" }).search,
    true,
    "garbage is not false"
  );
  assert.equal(resolveOptions({}).search, true, "and unset is on");
  assert.equal(resolveOptions({ fetch: "false" }).fetch, false);
  assert.equal(resolveOptions({}).fetch, true);

  for (const field of FIELDS) {
    assert.equal(
      resolveOptions(validated)[field.name],
      field.default,
      `${field.name}: an unset row yields the stated default`
    );
    assert.equal(
      resolveOptions({ [field.name]: "" })[field.name],
      field.junk,
      `${field.name}: an unusable value degrades to the same thing`
    );
    assert.equal(
      resolveOptions({ [field.name]: field.set })[field.name],
      field.set,
      `${field.name}: an explicit value is honoured, not silently dropped`
    );
  }
});

test("a validated row and a raw row resolve identically", () => {
  // The two shapes reach `resolveOptions` from different layers: the harness
  // validates a patch row before the plugin sees it, while a row this plugin
  // never validated arrives raw. They must not disagree about a default.
  const cases = [{}, { channel: "monid" }, { attempts: 5 }, { apiKeyEnv: "X" }];
  for (const row of cases) {
    const label = JSON.stringify(row);
    assert.deepEqual(
      resolveOptions(Config(row)),
      resolveOptions(row),
      `${label}: validated and raw agree`
    );
  }
});

/* ------------------------------------------ 2. the credential precedence chain */

/**
 * The order, once, as a comment worth having in code:
 *
 *   1. `apiKey` in the row        — a literal, which nothing should use
 *   2. `ctx.credentials`          — what a user typed into Settings
 *   3. the launch environment     — the shell as it was at boot
 *   4. the live environment       — the shell as it is now
 *   5. the channel's CLI store    — `monid keys add` / `tinyfish auth login`
 *
 * The harness services sit above the environment on purpose: a value someone
 * typed into Settings is a more deliberate choice than one that merely happens
 * to be exported. Rungs 2 and 3 are ordered *inside* the resolver closure and
 * are tested in section 2b, where the real order is observable.
 */

test("1. a literal apiKey outranks every other source", async () => {
  const key = await resolveApiKeyAsync("monid", {
    apiKey: "  literal  ",
    env: { MONID_API_KEY: "env" },
    apiKeyEnv: "MY_KEY",
    resolveCredential: async () => ({ value: "settings" }),
    credentialsPath: monidStore,
  });
  assert.equal(key, "literal", "trimmed, and nothing below it is consulted");
});

test("the live environment outranks the CLI store", async () => {
  const key = await resolveApiKeyAsync("monid", {
    env: { MONID_API_KEY: "env" },
    resolveCredential: async () => {},
    credentialsPath: monidStore,
  });
  assert.equal(key, "env");
});

test("the CLI store is the last resort, and is per-channel", async () => {
  assert.equal(
    await resolveApiKeyAsync("monid", {
      env: {},
      resolveCredential: async () => {},
      credentialsPath: monidStore,
    }),
    "from_monid_store"
  );
  assert.equal(
    await resolveApiKeyAsync("direct", {
      env: {},
      resolveCredential: async () => {},
      credentialsPath: monidStore,
      tinyfishConfigPath: tinyfishStore,
    }),
    "from_tinyfish_store"
  );
});

test("no source means no key, and no throw", () => {
  for (const channel of ["monid", "direct"]) {
    assert.equal(
      resolveApiKey(channel, {
        env: {},
        credentialsPath: missing,
        tinyfishConfigPath: missing,
      }),
      "",
      `${channel}: an absent store is empty, not an exception`
    );
  }
});

test("the two channels never read each other's environment or store", () => {
  // A `monid` key must not satisfy a `direct` request. If it did, a host with
  // only one of the two configured would appear to work and then fail at the
  // first request, which is the expensive kind of wrong.
  assert.equal(
    resolveApiKey("direct", {
      env: { MONID_API_KEY: "m" },
      tinyfishConfigPath: missing,
    }),
    ""
  );
  assert.equal(
    resolveApiKey("monid", {
      env: { TINYFISH_API_KEY: "t" },
      credentialsPath: missing,
    }),
    ""
  );
});

test("MONID_MCP_TOKEN is accepted, so a host's existing Monid mount suffices", () => {
  // The platform key a Monid MCP mount already holds is the same credential.
  // Requiring a second copy of it would make this plugin's credential
  // configuration strictly harder than the MCP server's.
  assert.equal(
    resolveApiKey("monid", {
      env: { MONID_MCP_TOKEN: "mcp" },
      credentialsPath: missing,
    }),
    "mcp"
  );
  assert.equal(
    resolveApiKey("monid", {
      env: { MONID_API_KEY: "primary", MONID_MCP_TOKEN: "mcp" },
      credentialsPath: missing,
    }),
    "primary",
    "MONID_API_KEY is the more specific name and wins"
  );
});

test("an aborted caller never gets a key, even from a service that would answer", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveApiKeyAsync("monid", {
      env: { MONID_API_KEY: "env" },
      signal: controller.signal,
      apiKeyEnv: "MY_KEY",
      resolveCredential: async () => ({ value: "settings" }),
      credentialsPath: monidStore,
    }),
    (error) => error.code === "WEB_ABORTED" || error.name === "AbortError",
    "the guard runs before the resolver is invoked, so a cancelled lookup never starts"
  );
});

/* ---------------------------------------- 2b. the order inside the resolver */

/*
 * Rungs 2 and 3 both live inside the closure `credentialLookup` builds, because
 * the launch environment is a harness service rather than something the client
 * can reach. So the order between them is only observable through the plugin:
 * apply it against a context carrying both services, then read the resolver off
 * the registered provider.
 */

function ctxWith({
  credential,
  ambient,
  withCredentials = true,
  withLaunch = true,
}) {
  const services = {
    // `credentialRef(name)` returns the plain string, not a wrapper object — an
    // earlier version of this stub looked for `.name` and matched nothing, which
    // read as the launch environment winning when the service simply never fired.
    credentials: {
      resolve: async (ref) =>
        ref === "MY_KEY" ? { value: credential } : undefined,
    },
    launchEnvironment: {
      get: (ref) => (ref === "MY_KEY" ? { value: ambient } : undefined),
    },
  };
  return {
    get: (name) => {
      if (name === "credentials") {
        if (!withCredentials) throw new Error("service not mounted");
        return services.credentials;
      }
      if (name === "launchEnvironment") {
        if (!withLaunch) throw new Error("service not mounted");
        return services.launchEnvironment;
      }
      throw new Error(`unknown service ${name}`);
    },
  };
}

async function resolverFrom(base) {
  const ctx = {
    get: base.get,
    web: {
      registerSearchProvider: (p) => (ctx.web.__search = p),
      registerFetchProvider: (p) => (ctx.web.__fetch = p),
    },
  };
  const registered = {};
  apply(ctx, {}); // `apply(ctx, config)` — the seam comes from the context.
  registered.search = ctx.web.__search;
  return registered.search.resolveOptions().resolveCredential;
}

test("2. the credentials service outranks the launch environment", async () => {
  // The layer a user edits from Settings is more deliberate than one frozen at
  // boot, so it is consulted first.
  const resolve = await resolverFrom(
    ctxWith({ credential: "settings", ambient: "boot" })
  );
  assert.equal(await resolve("MY_KEY"), "settings");
});

test("3. the launch environment is used when no credentials service answers", async () => {
  const resolve = await resolverFrom(
    ctxWith({ credential: undefined, ambient: "boot" })
  );
  assert.equal(await resolve("MY_KEY"), "boot");
});

test("a host with neither service still loads, and falls through to the stores", async () => {
  // Registration must not fail because a service is absent — that would make
  // the plugin unloadable on a host that mounts neither.
  const resolve = await resolverFrom(
    ctxWith({ withCredentials: false, withLaunch: false })
  );
  assert.equal(resolve, undefined, "no resolver is offered at all");
  assert.equal(
    resolveApiKey("monid", {
      env: { MONID_API_KEY: "env" },
      credentialsPath: monidStore,
    }),
    "env",
    "so the environment and the CLI store still apply"
  );
});

test("an unknown credential ref yields nothing rather than the wrong key", async () => {
  const resolve = await resolverFrom(
    ctxWith({ credential: "settings", ambient: "boot" })
  );
  assert.equal(await resolve("SOME_OTHER_KEY"), undefined);
});

/* ----------------------------------------------------- 3. layer precedence */

test("a host patch row overrides the bundle default", () => {
  // The bundle ships no `channel`, so the schema default (`direct`) stands. A
  // host that prefers the Monid envelope adds `channel: monid` to its own patch
  // layer, and DSH's precedence makes the host win. That is the whole reason
  // the default is a default and not a pin.
  assert.equal(resolveOptions({}).channel, "direct", "the bundle default");
  assert.equal(
    resolveOptions({ channel: "monid" }).channel,
    "monid",
    "the host override"
  );
  assert.equal(
    resolveOptions(Config({ channel: "monid" })).channel,
    "monid",
    "and it survives schema validation, which is what a patch row goes through"
  );
});

test("endpoints resolve config row, then environment, then built-in default", () => {
  // The three-rung shape the shipped providers use for
  // `$DEEPSEEK_SEARCH_BASE_URL`. A deployment can retarget without a patch file.
  assert.equal(
    resolveOptions({}, undefined, {
      TINYFISH_SEARCH_BASE_URL: "https://staging.example",
    }).searchBase,
    "https://staging.example",
    "environment applies when the row is silent"
  );
  assert.equal(
    resolveOptions({ searchBase: "https://row.example" }, undefined, {
      TINYFISH_SEARCH_BASE_URL: "https://env.example",
    }).searchBase,
    "https://row.example",
    "the row outranks the environment"
  );
  assert.equal(
    resolveOptions({}, undefined, {}).searchBase,
    "https://api.search.tinyfish.ai",
    "and the built-in default stands when both are silent"
  );
  for (const [field, variable] of [
    ["monidBase", "TINYFISH_MONID_BASE_URL"],
    ["searchBase", "TINYFISH_SEARCH_BASE_URL"],
    ["fetchBase", "TINYFISH_FETCH_BASE_URL"],
  ]) {
    assert.equal(
      resolveOptions({}, undefined, { [variable]: "https://env.example" })[
        field
      ],
      "https://env.example",
      `${variable} retargets ${field}`
    );
  }
});

// Cleanup has to be a hook, not top-level code: a bare call here runs at
// *import*, before any test, so it deleted the stores the tests read. That is
// what the unused-import warning was pointing at — the cleanup was missing — and
// putting it back in the wrong place broke the suite instead of fixing it.
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
